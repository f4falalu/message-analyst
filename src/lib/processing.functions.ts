import { createServerFn } from "@tanstack/react-start";
import { readDocument } from "./doc-reader.server";
import { buildRecords, type BuilderAttachment, type BuilderMessage } from "./record-builder";
import type { Json } from "@/integrations/supabase/types";

export const startProcessingRun = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string; concurrency: number; chunkSize: number; kind?: string }) => ({
    importId: String(input.importId),
    concurrency: Math.max(1, Math.min(8, Number(input.concurrency))),
    chunkSize: Math.max(1, Math.min(12, Number(input.chunkSize))),
    kind: String(input.kind ?? "ocr"),
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    const { count } = await supabase
      .from("attachments")
      .select("id", { count: "exact", head: true })
      .eq("import_id", data.importId)
      .eq("ocr_status", "pending");

    const { data: run, error } = await supabase
      .from("processing_runs")
      .insert({
        import_id: data.importId,
        kind: data.kind,
        status: "running",
        concurrency: data.concurrency,
        chunk_size: data.chunkSize,
        total_files: count ?? 0,
      })
      .select("id")
      .single();
    if (error || !run) throw new Error(error?.message ?? "Could not start the run.");
    return { runId: run.id, totalFiles: count ?? 0 };
  });

export const finishProcessingRun = createServerFn({ method: "POST" })
  .inputValidator((input: { runId: string; status: string; notes?: string | null }) => ({
    runId: String(input.runId),
    status: String(input.status),
    notes: input.notes ? String(input.notes).slice(0, 500) : null,
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    const counts = await Promise.all(
      (["done", "error"] as const).map(async (outcome) => {
        const { count } = await supabase
          .from("processing_events")
          .select("id", { count: "exact", head: true })
          .eq("run_id", data.runId)
          .eq("outcome", outcome);
        return count ?? 0;
      }),
    );

    const { error } = await supabase
      .from("processing_runs")
      .update({
        status: data.status,
        notes: data.notes,
        processed_count: counts[0] ?? 0,
        failed_count: counts[1] ?? 0,
        finished_at: new Date().toISOString(),
      })
      .eq("id", data.runId);
    if (error) throw new Error(error.message);
    return { processed: counts[0] ?? 0, failed: counts[1] ?? 0 };
  });

export const processAttachmentBatch = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string; limit?: number; runId?: string | null }) => ({
    importId: String(input.importId),
    limit: Math.max(1, Math.min(12, Number(input.limit ?? 6))),
    runId: input.runId ? String(input.runId) : null,
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    // Atomic claim: safe when several batches run at the same time.
    const { data: pending, error: claimError } = await supabase.rpc("claim_attachments", {
      _import_id: data.importId,
      _limit: data.limit,
    });

    if (claimError) throw new Error(claimError.message);
    if (!pending || pending.length === 0) {
      const { count } = await supabase
        .from("attachments")
        .select("id", { count: "exact", head: true })
        .eq("import_id", data.importId)
        .eq("ocr_status", "pending");
      return { processed: 0, failed: 0, remaining: count ?? 0, rateLimited: false, creditsExhausted: false };
    }

    let processed = 0;
    let failed = 0;
    let rateLimited = false;
    let creditsExhausted = false;

    type EventRow = {
      run_id: string;
      import_id: string;
      attachment_id: string;
      filename: string;
      outcome: string;
      doc_type: string | null;
      confidence: number | null;
      field_confidence: Json | null;
      duration_ms: number;
      error: string | null;
    };
    const events: EventRow[] = [];

    await Promise.all(
      pending.map(async (attachment) => {
        const startedAt = Date.now();
        try {
          const { data: signed, error: signError } = await supabase.storage
            .from("wa-archive")
            .createSignedUrl(attachment.storage_path, 900);
          if (signError || !signed?.signedUrl) throw new Error(signError?.message ?? "Could not sign file URL");

          let chatContext = "";
          if (attachment.message_seq !== null) {
            const { data: nearby } = await supabase
              .from("messages")
              .select("sent_at, sender, body")
              .eq("import_id", data.importId)
              .gte("seq", attachment.message_seq - 3)
              .lte("seq", attachment.message_seq + 3)
              .order("seq", { ascending: true });
            chatContext = (nearby ?? [])
              .map((m) => `${m.sent_at ?? ""} ${m.sender ?? ""}: ${(m.body ?? "").slice(0, 400)}`)
              .join("\n")
              .slice(0, 3000);
          }

          const extracted = await readDocument({
            apiKey,
            mimeType: attachment.mime_type ?? "application/octet-stream",
            filename: attachment.filename,
            signedUrl: signed.signedUrl,
            chatContext,
          });

          const { error: updateError } = await supabase
            .from("attachments")
            .update({
              ocr_status: "done",
              ocr_error: null,
              raw_text: extracted.raw_text,
              extracted: extracted as unknown as Json,
              processed_at: new Date().toISOString(),
            })
            .eq("id", attachment.id);
          if (updateError) throw new Error(updateError.message);
          processed += 1;

          if (data.runId) {
            events.push({
              run_id: data.runId,
              import_id: data.importId,
              attachment_id: attachment.id,
              filename: attachment.filename,
              outcome: "done",
              doc_type: extracted.doc_type,
              confidence: extracted.confidence,
              field_confidence: extracted.field_confidence as unknown as Json,
              duration_ms: Date.now() - startedAt,
              error: null,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("[429]")) rateLimited = true;
          if (message.includes("[402]")) creditsExhausted = true;
          failed += 1;
          const requeued = message.includes("[429]");
          await supabase
            .from("attachments")
            .update({
              ocr_status: requeued ? "pending" : "error",
              ocr_error: message.slice(0, 800),
              processed_at: new Date().toISOString(),
            })
            .eq("id", attachment.id);

          if (data.runId) {
            events.push({
              run_id: data.runId,
              import_id: data.importId,
              attachment_id: attachment.id,
              filename: attachment.filename,
              outcome: requeued ? "requeued" : "error",
              doc_type: null,
              confidence: null,
              field_confidence: null,
              duration_ms: Date.now() - startedAt,
              error: message.slice(0, 800),
            });
          }
        }
      }),
    );

    if (events.length) {
      await supabase.from("processing_events").insert(events);
    }

    const { count } = await supabase
      .from("attachments")
      .select("id", { count: "exact", head: true })
      .eq("import_id", data.importId)
      .eq("ocr_status", "pending");

    return { processed, failed, remaining: count ?? 0, rateLimited, creditsExhausted };
  });

export const retryFailedAttachments = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string }) => ({ importId: String(input.importId) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const { error, count } = await supabase
      .from("attachments")
      .update({ ocr_status: "pending", ocr_error: null }, { count: "exact" })
      .eq("import_id", data.importId)
      .eq("ocr_status", "error");
    if (error) throw new Error(error.message);
    return { requeued: count ?? 0 };
  });

export const rebuildRecords = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string }) => ({ importId: String(input.importId) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    const messages: BuilderMessage[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from("messages")
        .select("id, seq, sent_at, sender, body")
        .eq("import_id", data.importId)
        .order("seq", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!page || page.length === 0) break;
      messages.push(...page);
      if (page.length < 1000) break;
    }

    const attachments: BuilderAttachment[] = [];
    for (let from = 0; ; from += 500) {
      const { data: page, error } = await supabase
        .from("attachments")
        .select("id, filename, message_seq, extracted")
        .eq("import_id", data.importId)
        .eq("ocr_status", "done")
        .order("filename", { ascending: true })
        .range(from, from + 499);
      if (error) throw new Error(error.message);
      if (!page || page.length === 0) break;
      attachments.push(
        ...page.map((row) => ({
          id: row.id,
          filename: row.filename,
          message_seq: row.message_seq,
          extracted: (row.extracted ?? null) as BuilderAttachment["extracted"],
        })),
      );
      if (page.length < 500) break;
    }

    const built = buildRecords(messages, attachments);

    const { error: deleteError } = await supabase
      .from("request_records")
      .delete()
      .eq("import_id", data.importId);
    if (deleteError) throw new Error(deleteError.message);

    for (let i = 0; i < built.length; i += 200) {
      const slice = built.slice(i, i + 200);
      const { data: inserted, error: insertError } = await supabase
        .from("request_records")
        .insert(
          slice.map((record) => ({
            import_id: data.importId,
            user_id: null,
            facility_name: record.facility_name,
            items: record.items as unknown as Json,
            amount_paid: record.amount_paid,
            currency: record.currency,
            request_date: record.request_date,
            payment_date: record.payment_date,
            requester_name: record.requester_name,
            requester_phone: record.requester_phone,
            status: record.status,
            confidence: record.confidence,
            needs_review: record.needs_review,
            notes: record.notes,
          })),
        )
        .select("id");
      if (insertError) throw new Error(insertError.message);

      const sourceRows = (inserted ?? []).flatMap((row, index) =>
        (slice[index]?.sources ?? []).map((source) => ({
          record_id: row.id,
          user_id: null,
          kind: source.kind,
          message_id: source.message_id ?? null,
          attachment_id: source.attachment_id ?? null,
        })),
      );
      if (sourceRows.length) {
        const { error: sourceError } = await supabase.from("record_sources").insert(sourceRows);
        if (sourceError) throw new Error(sourceError.message);
      }
    }

    await supabase
      .from("imports")
      .update({ status: "ready" })
      .eq("id", data.importId);

    return { records: built.length, needsReview: built.filter((record) => record.needs_review).length };
  });
