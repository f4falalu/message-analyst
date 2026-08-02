import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { readDocument } from "./doc-reader.server";
import { buildRecords, type BuilderAttachment, type BuilderMessage } from "./record-builder";

export const processAttachmentBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { importId: string; limit?: number }) => ({
    importId: String(input.importId),
    limit: Math.max(1, Math.min(12, Number(input.limit ?? 6))),
  }))
  .handler(async ({ data, context }) => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");
    const supabase = context.supabase;

    const { data: pending, error: pendingError } = await supabase
      .from("attachments")
      .select("id, filename, storage_path, mime_type, message_seq")
      .eq("import_id", data.importId)
      .eq("ocr_status", "pending")
      .order("filename", { ascending: true })
      .limit(data.limit);

    if (pendingError) throw new Error(pendingError.message);
    if (!pending || pending.length === 0) return { processed: 0, failed: 0, remaining: 0 };

    const ids = pending.map((row) => row.id);
    await supabase.from("attachments").update({ ocr_status: "processing" }).in("id", ids);

    let processed = 0;
    let failed = 0;
    let rateLimited = false;
    let creditsExhausted = false;

    await Promise.all(
      pending.map(async (attachment) => {
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
              extracted: extracted as unknown as Record<string, unknown>,
              processed_at: new Date().toISOString(),
            })
            .eq("id", attachment.id);
          if (updateError) throw new Error(updateError.message);
          processed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("[429]")) rateLimited = true;
          if (message.includes("[402]")) creditsExhausted = true;
          failed += 1;
          await supabase
            .from("attachments")
            .update({
              ocr_status: message.includes("[429]") ? "pending" : "error",
              ocr_error: message.slice(0, 800),
              processed_at: new Date().toISOString(),
            })
            .eq("id", attachment.id);
        }
      }),
    );

    const { count } = await supabase
      .from("attachments")
      .select("id", { count: "exact", head: true })
      .eq("import_id", data.importId)
      .eq("ocr_status", "pending");

    return { processed, failed, remaining: count ?? 0, rateLimited, creditsExhausted };
  });

export const retryFailedAttachments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { importId: string }) => ({ importId: String(input.importId) }))
  .handler(async ({ data, context }) => {
    const { error, count } = await context.supabase
      .from("attachments")
      .update({ ocr_status: "pending", ocr_error: null }, { count: "exact" })
      .eq("import_id", data.importId)
      .eq("ocr_status", "error");
    if (error) throw new Error(error.message);
    return { requeued: count ?? 0 };
  });

export const rebuildRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { importId: string }) => ({ importId: String(input.importId) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;

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
            user_id: context.userId,
            facility_name: record.facility_name,
            items: record.items as unknown as Record<string, unknown>[],
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
          user_id: context.userId,
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
