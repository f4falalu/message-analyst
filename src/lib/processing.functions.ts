import { createServerFn } from "@tanstack/react-start";
import { DeferError, readDocument } from "./doc-reader.server";
import { buildRecords, chatFactsFor, type BuilderAttachment, type BuilderMessage } from "./record-builder";
import { crossCheckSources, type Issue, type Mapping } from "./data-rules";
import type { Json } from "@/integrations/supabase/types";

export const startProcessingRun = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string; concurrency: number; chunkSize: number; kind?: string; retryFailed?: boolean }) => ({
    importId: String(input.importId),
    concurrency: Math.max(1, Math.min(8, Number(input.concurrency))),
    chunkSize: Math.max(1, Math.min(12, Number(input.chunkSize))),
    kind: String(input.kind ?? "ocr"),
    retryFailed: input.retryFailed !== false,
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    let requeued = 0;
    if (data.retryFailed) {
      // Automatic retry: anything that failed or was left half-parsed goes
      // back in the queue when a new run starts (including after a resume).
      const { count } = await supabase
        .from("attachments")
        .update({ ocr_status: "pending", ocr_error: null }, { count: "exact" })
        .eq("import_id", data.importId)
        .in("ocr_status", ["error", "processing", "deferred"]);
      requeued = count ?? 0;
    }

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
    return { runId: run.id, totalFiles: count ?? 0, requeued };
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
  .inputValidator(
    (input: {
      importId: string;
      limit?: number;
      runId?: string | null;
      minBytes?: number | null;
      maxBytes?: number | null;
    }) => ({
      importId: String(input.importId),
      // Kept small on purpose: each file in a batch is read into worker memory,
      // and larger batches were tripping the server memory limit (502s).
      limit: Math.max(1, Math.min(4, Number(input.limit ?? 3))),
      runId: input.runId ? String(input.runId) : null,
      // Size band: normal lanes take the small files, the heavy lane takes the
      // big ones one at a time so a large document gets the whole memory budget.
      minBytes: input.minBytes === null || input.minBytes === undefined ? null : Number(input.minBytes),
      maxBytes: input.maxBytes === null || input.maxBytes === undefined ? null : Number(input.maxBytes),
    }),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    // Atomic claim: safe when several batches run at the same time.
    const claimArgs: { _import_id: string; _limit: number; _min_bytes?: number; _max_bytes?: number } = {
      _import_id: data.importId,
      _limit: data.limit,
    };
    if (data.minBytes !== null) claimArgs._min_bytes = data.minBytes;
    if (data.maxBytes !== null) claimArgs._max_bytes = data.maxBytes;
    const { data: pending, error: claimError } = await supabase.rpc("claim_attachments", claimArgs);

    if (claimError) throw new Error(claimError.message);

    if (!pending || pending.length === 0) {
      const { count } = await supabase
        .from("attachments")
        .select("id", { count: "exact", head: true })
        .eq("import_id", data.importId)
        .eq("ocr_status", "pending");
      return {
        processed: 0,
        failed: 0,
        deferred: 0,
        remaining: count ?? 0,
        rateLimited: false,
        creditsExhausted: false,
        files: [] as {
          attachmentId: string;
          filename: string;
          outcome: string;
          confidence: number | null;
          durationMs: number;
          attempts: number;
          error: string | null;
        }[],
      };

    }

    let processed = 0;
    let failed = 0;
    let deferred = 0;
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

    type FileResult = {
      attachmentId: string;
      filename: string;
      outcome: string;
      confidence: number | null;
      durationMs: number;
      attempts: number;
      error: string | null;
    };
    const files: FileResult[] = [];


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

          // Automatic retry: transient failures (rate limits, network, gateway
          // hiccups) get up to two extra attempts before the file is marked failed.
          let extracted: Awaited<ReturnType<typeof readDocument>> | null = null;
          let attempts = 0;
          let lastTransient = "";
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            attempts = attempt;
            try {
              extracted = await readDocument({
                apiKey,
                mimeType: attachment.mime_type ?? "application/octet-stream",
                filename: attachment.filename,
                signedUrl: signed.signedUrl,
                chatContext,
              });
              break;
            } catch (readError) {
              const text = readError instanceof Error ? readError.message : String(readError);
              const transient =
                text.includes("[429]") ||
                text.includes("[500]") ||
                text.includes("[502]") ||
                text.includes("[503]") ||
                text.includes("[504]") ||
                /fetch failed|network|timeout|aborted/i.test(text);
              if (!transient || attempt === 3) throw readError;
              lastTransient = text;
              await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
            }
          }
          if (!extracted) throw new Error(lastTransient || "The document could not be read.");

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
          files.push({
            attachmentId: attachment.id,
            filename: attachment.filename,
            outcome: "done",
            confidence: extracted.confidence,
            durationMs: Date.now() - startedAt,
            attempts,
            error: null,
          });

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
              error: attempts > 1 ? `Recovered after ${attempts} attempts` : null,
            });
          }

        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("[429]")) rateLimited = true;
          if (message.includes("[402]")) creditsExhausted = true;
          const requeued = message.includes("[429]");
          // A deferred file is *unread*, not empty — it must never look like a
          // document that was read and had nothing in it.
          const isDeferred = error instanceof DeferError || (error as { deferred?: boolean })?.deferred === true;
          if (!isDeferred) failed += 1;
          else deferred += 1;
          const outcome = requeued ? "requeued" : isDeferred ? "deferred" : "error";
          await supabase
            .from("attachments")
            .update({
              ocr_status: requeued ? "pending" : isDeferred ? "deferred" : "error",
              ocr_error: message.slice(0, 800),
              processed_at: new Date().toISOString(),
            })
            .eq("id", attachment.id);

          files.push({
            attachmentId: attachment.id,
            filename: attachment.filename,
            outcome,
            confidence: null,
            durationMs: Date.now() - startedAt,
            attempts: 1,
            error: message.slice(0, 300),
          });



          if (data.runId) {
            events.push({
              run_id: data.runId,
              import_id: data.importId,
              attachment_id: attachment.id,
              filename: attachment.filename,
              outcome,
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

    return { processed, failed, deferred, remaining: count ?? 0, rateLimited, creditsExhausted, files };
  });

export const reprocessAttachment = createServerFn({ method: "POST" })
  .inputValidator((input: { attachmentId: string; runId?: string | null }) => ({
    attachmentId: String(input.attachmentId),
    runId: input.runId ? String(input.runId) : null,
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const { data: attachment, error } = await supabase
      .from("attachments")
      .select("id, import_id, filename, storage_path, mime_type, message_seq")
      .eq("id", data.attachmentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!attachment) throw new Error("That file is no longer in the archive.");

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
          .eq("import_id", attachment.import_id)
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

      await supabase
        .from("attachments")
        .update({
          ocr_status: "done",
          ocr_error: null,
          raw_text: extracted.raw_text,
          extracted: extracted as unknown as Json,
          processed_at: new Date().toISOString(),
        })
        .eq("id", attachment.id);

      if (data.runId) {
        await supabase.from("processing_events").insert({
          run_id: data.runId,
          import_id: attachment.import_id,
          attachment_id: attachment.id,
          filename: attachment.filename,
          outcome: "done",
          doc_type: extracted.doc_type,
          confidence: extracted.confidence,
          field_confidence: extracted.field_confidence as unknown as Json,
          duration_ms: Date.now() - startedAt,
          error: "Manual reprocess",
        });
      }

      return { ok: true, filename: attachment.filename, confidence: extracted.confidence, error: null as string | null };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const isDeferred = caught instanceof DeferError || (caught as { deferred?: boolean })?.deferred === true;
      await supabase
        .from("attachments")
        .update({
          ocr_status: isDeferred ? "deferred" : "error",
          ocr_error: message.slice(0, 800),
          processed_at: new Date().toISOString(),
        })
        .eq("id", attachment.id);
      if (data.runId) {
        await supabase.from("processing_events").insert({
          run_id: data.runId,
          import_id: attachment.import_id,
          attachment_id: attachment.id,
          filename: attachment.filename,
          outcome: isDeferred ? "deferred" : "error",
          duration_ms: Date.now() - startedAt,
          error: message.slice(0, 800),
        });
      }
      return { ok: false, filename: attachment.filename, confidence: null, error: message.slice(0, 300) };
    }
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

export const getAttachmentPreview = createServerFn({ method: "POST" })
  .inputValidator((input: { attachmentId: string }) => ({ attachmentId: String(input.attachmentId) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabase
      .from("attachments")
      .select(
        "id, import_id, message_seq, filename, mime_type, storage_path, raw_text, extracted, ocr_status, ocr_error, size_bytes",
      )
      .eq("id", data.attachmentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("That file is no longer in the archive.");

    const { data: signed } = await supabase.storage.from("wa-archive").createSignedUrl(row.storage_path, 3600);

    // Compare the chat transcript around this file with what was read off it.
    let mismatches: Issue[] = [];
    let chatContext: { seq: number; sent_at: string | null; sender: string | null; body: string | null }[] = [];
    const extracted = (row.extracted ?? null) as {
      facility_name: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      document_date: string | null;
      payment_date: string | null;
    } | null;

    if (row.message_seq !== null) {
      const { data: context } = await supabase
        .from("messages")
        .select("seq, sent_at, sender, body")
        .eq("import_id", row.import_id)
        .gte("seq", row.message_seq - 4)
        .lte("seq", row.message_seq + 4)
        .order("seq", { ascending: true });
      chatContext = context ?? [];

      if (extracted) {
        const { data: mappingRows } = await supabase
          .from("name_mappings")
          .select("kind, pattern, canonical")
          .eq("active", true)
          .limit(5000);
        const anchor = chatContext.find((message) => message.seq === row.message_seq);
        const contextText = chatContext.map((message) => message.body ?? "").join("\n");
        mismatches = crossCheckSources(
          chatFactsFor(
            anchor ? { id: "", seq: anchor.seq, sent_at: anchor.sent_at, sender: anchor.sender, body: anchor.body } : undefined,
            chatContext.map((message) => ({ id: "", ...message })),
            contextText,
          ),
          {
            facility_name: extracted.facility_name ?? null,
            contact_name: extracted.contact_name ?? null,
            contact_phone: extracted.contact_phone ?? null,
            document_date: extracted.document_date ?? null,
            payment_date: extracted.payment_date ?? null,
          },
          (mappingRows ?? []) as Mapping[],
        );
      }
    }

    return {
      mismatches,
      chatContext,
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      ocrStatus: row.ocr_status,
      ocrError: row.ocr_error,
      rawText: row.raw_text,
      extracted: row.extracted,
      url: signed?.signedUrl ?? null,
    };
  });

/** Files in one import, with their queue state — powers the Files tab. */
export const listImportFiles = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string; status?: string; search?: string; page?: number; pageSize?: number }) => ({
    importId: String(input.importId),
    status: String(input.status ?? "all"),
    search: String(input.search ?? "").trim(),
    page: Math.max(0, Number(input.page ?? 0)),
    pageSize: Math.max(10, Math.min(200, Number(input.pageSize ?? 50))),
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    let query = supabase
      .from("attachments")
      .select("id, filename, mime_type, size_bytes, ocr_status, ocr_error, message_seq, processed_at", {
        count: "exact",
      })
      .eq("import_id", data.importId);

    if (data.status !== "all") query = query.eq("ocr_status", data.status);
    if (data.search) query = query.ilike("filename", `%${data.search}%`);

    const from = data.page * data.pageSize;
    const { data: rows, error, count } = await query
      .order("filename", { ascending: true })
      .range(from, from + data.pageSize - 1);
    if (error) throw new Error(error.message);

    return { files: rows ?? [], total: count ?? 0, page: data.page, pageSize: data.pageSize };
  });

/**
 * Moves files back into the parse queue — either specific ones, everything that
 * failed, or files a crashed run left stuck in "processing".
 */
export const requeueAttachments = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string; attachmentIds?: string[]; scope?: string; runId?: string | null }) => ({
    importId: String(input.importId),
    attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds.map(String).slice(0, 500) : [],
    scope: String(input.scope ?? "ids"),
    runId: input.runId ? String(input.runId) : null,
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    let target = supabase
      .from("attachments")
      .update({ ocr_status: "pending", ocr_error: null }, { count: "exact" })
      .eq("import_id", data.importId);

    if (data.scope === "failed") {
      target = target.eq("ocr_status", "error");
    } else if (data.scope === "stuck") {
      // Left claimed by a run that died: still "processing" and untouched for a while.
      const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      target = target.eq("ocr_status", "processing").or(`processed_at.is.null,processed_at.lt.${cutoff}`);
    } else if (data.scope === "skipped") {
      target = target.eq("ocr_status", "skipped");
    } else if (data.scope === "deferred") {
      target = target.eq("ocr_status", "deferred");
    } else {
      if (data.attachmentIds.length === 0) return { requeued: 0 };
      target = target.in("id", data.attachmentIds);
    }

    const { error, count } = await target.select("id, filename");
    if (error) throw new Error(error.message);
    return { requeued: count ?? 0 };
  });

/** Stops a junk file from being retried for good. */
export const setAttachmentSkipped = createServerFn({ method: "POST" })
  .inputValidator((input: { attachmentId: string; reason?: string }) => ({
    attachmentId: String(input.attachmentId),
    reason: String(input.reason ?? "Marked as skipped by hand").slice(0, 300),
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const { error } = await supabase
      .from("attachments")
      .update({ ocr_status: "skipped", ocr_error: data.reason, processed_at: new Date().toISOString() })
      .eq("id", data.attachmentId);
    if (error) throw new Error(error.message);
    return { ok: true };
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

    const { data: mappingRows } = await supabase
      .from("name_mappings")
      .select("kind, pattern, canonical")
      .eq("active", true)
      .limit(5000);
    const mappings = (mappingRows ?? []) as Mapping[];

    const built = buildRecords(messages, attachments, mappings);

    // Documents that have NOT been read yet (queued, in flight, deferred or
    // failed). Without this, a record built next to an unread file would look
    // like the document simply didn't mention anything.
    const unread: { message_seq: number | null; ocr_status: string }[] = [];
    for (let from = 0; ; from += 500) {
      const { data: page, error } = await supabase
        .from("attachments")
        .select("message_seq, ocr_status")
        .eq("import_id", data.importId)
        .in("ocr_status", ["pending", "processing", "deferred", "error"])
        .order("filename", { ascending: true })
        .range(from, from + 499);
      if (error) throw new Error(error.message);
      if (!page || page.length === 0) break;
      unread.push(...page);
      if (page.length < 500) break;
    }

    const unreadSeqs = unread
      .map((row) => row.message_seq)
      .filter((seq): seq is number => seq !== null)
      .sort((a, b) => a - b);
    const seqOf = new Map(attachments.map((a) => [a.id, a.message_seq] as const));

    if (unread.length > 0) {
      for (const record of built) {
        const anchors = record.sources
          .map((source) => (source.attachment_id ? seqOf.get(source.attachment_id) ?? null : null))
          .filter((seq): seq is number => seq !== null);
        const nearby = unreadSeqs.filter((seq) => anchors.some((anchor) => Math.abs(seq - anchor) <= 4)).length;
        if (nearby === 0) continue;
        record.issues = [
          ...record.issues,
          {
            level: "warning" as const,
            field: "sources",
            message: `Evidence incomplete — ${nearby} attachment${nearby === 1 ? "" : "s"} near this record ${
              nearby === 1 ? "has" : "have"
            } not been read yet.`,
          },
        ];
        record.needs_review = true;
      }
    }

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
            issues: record.issues as unknown as Json,
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

    return {
      records: built.length,
      needsReview: built.filter((record) => record.needs_review).length,
      flagged: built.filter((record) => record.issues.some((issue) => issue.level === "error")).length,
    };
  });
