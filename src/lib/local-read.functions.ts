// Server side of the "read on this computer" lane.
//
// The browser can reach a model running on the user's own machine; Lovable's
// servers cannot. So the server only hands out work (signed file URLs plus the
// surrounding chat) and stores the result — the model call itself happens in
// the browser (see local-read.ts).

import { createServerFn } from "@tanstack/react-start";
import type { ExtractedDoc } from "./doc-extract";
import type { Json } from "@/integrations/supabase/types";

export type LocalProviderInfo = {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  authStyle: string;
  supportsPdf: boolean;
};

export type LocalJob = {
  attachmentId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  signedUrl: string;
  chatContext: string;
};

/** The active model, only when it is one that runs on the user's machine. */
export const getLocalProvider = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
  const { fromRow, PROVIDER_COLUMNS } = await import("./ai-provider.server");
  const { data } = await supabase
    .from("ai_providers")
    .select(PROVIDER_COLUMNS)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) return { provider: null as LocalProviderInfo | null };
  const config = fromRow(data);
  if (config.runLocation !== "browser" || !config.id) return { provider: null as LocalProviderInfo | null };
  return {
    provider: {
      id: config.id,
      label: config.label,
      baseUrl: config.baseUrl,
      models: config.models,
      authStyle: config.authStyle,
      supportsPdf: config.supportsPdf,
    } satisfies LocalProviderInfo,
  };
});

async function chatContextFor(
  supabase: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
  importId: string,
  messageSeq: number | null,
): Promise<string> {
  if (messageSeq === null) return "";
  const { data: nearby } = await supabase
    .from("messages")
    .select("sent_at, sender, body")
    .eq("import_id", importId)
    .gte("seq", messageSeq - 3)
    .lte("seq", messageSeq + 3)
    .order("seq", { ascending: true });
  return (nearby ?? [])
    .map((m) => `${m.sent_at ?? ""} ${m.sender ?? ""}: ${(m.body ?? "").slice(0, 400)}`)
    .join("\n")
    .slice(0, 3000);
}

/** Claim a slice of pending files for the browser lane to read. */
export const claimLocalBatch = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { importId: string; limit?: number; minBytes?: number | null; maxBytes?: number | null }) => ({
      importId: String(input.importId),
      limit: Math.max(1, Math.min(6, Number(input.limit ?? 2))),
      minBytes: input.minBytes === null || input.minBytes === undefined ? null : Number(input.minBytes),
      maxBytes: input.maxBytes === null || input.maxBytes === undefined ? null : Number(input.maxBytes),
    }),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    const claimArgs: { _import_id: string; _limit: number; _min_bytes?: number; _max_bytes?: number } = {
      _import_id: data.importId,
      _limit: data.limit,
    };
    if (data.minBytes !== null) claimArgs._min_bytes = data.minBytes;
    if (data.maxBytes !== null) claimArgs._max_bytes = data.maxBytes;
    const { data: pending, error } = await supabase.rpc("claim_attachments", claimArgs);
    if (error) throw new Error(error.message);

    const jobs: LocalJob[] = [];
    for (const attachment of pending ?? []) {
      const { data: signed } = await supabase.storage
        .from("wa-archive")
        .createSignedUrl(attachment.storage_path, 3600);
      if (!signed?.signedUrl) {
        await supabase
          .from("attachments")
          .update({ ocr_status: "pending" })
          .eq("id", attachment.id);
        continue;
      }
      jobs.push({
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes ?? null,
        signedUrl: signed.signedUrl,
        chatContext: await chatContextFor(supabase, data.importId, attachment.message_seq),
      });
    }

    const { count } = await supabase
      .from("attachments")
      .select("id", { count: "exact", head: true })
      .eq("import_id", data.importId)
      .eq("ocr_status", "pending");

    return { jobs, remaining: count ?? 0 };
  });

/** Store the outcome of a browser-side read. */
export const saveLocalRead = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      importId: string;
      attachmentId: string;
      runId?: string | null;
      filename: string;
      durationMs?: number;
      extracted?: unknown;
      model?: string | null;
      error?: string | null;
      /** true = unread on purpose (PDF the local model can't take, too big …) */
      deferred?: boolean;
      /** true = the local model was unreachable, so the file goes back to waiting */
      requeue?: boolean;
    }) => ({
      importId: String(input.importId),
      attachmentId: String(input.attachmentId),
      runId: input.runId ? String(input.runId) : null,
      filename: String(input.filename).slice(0, 300),
      durationMs: Math.max(0, Number(input.durationMs ?? 0)),
      extracted: input.extracted ?? null,
      model: input.model ? String(input.model).slice(0, 200) : null,
      error: input.error ? String(input.error).slice(0, 800) : null,
      deferred: Boolean(input.deferred),
      requeue: Boolean(input.requeue),
    }),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    const extracted = data.extracted as ExtractedDoc | null;
    const ok = Boolean(extracted && !data.error);

    if (ok && extracted) {
      const { error } = await supabase
        .from("attachments")
        .update({
          ocr_status: "done",
          ocr_error: null,
          raw_text: extracted.raw_text,
          extracted: extracted as unknown as Json,
          processed_at: new Date().toISOString(),
        })
        .eq("id", data.attachmentId);
      if (error) throw new Error(error.message);

      // Remember it so a stopped-and-restarted import never re-reads this page.
      const { rememberExtraction } = await import("./extraction-cache.server");
      const { data: row } = await supabase
        .from("attachments")
        .select("filename, size_bytes")
        .eq("id", data.attachmentId)
        .maybeSingle();
      if (row) await rememberExtraction(supabase, row, extracted, data.model, "browser");
    } else {

      await supabase
        .from("attachments")
        .update({
          // Unreachable local model = still waiting, never a failed read: a file
          // recorded as read-and-empty would poison the matching later.
          ocr_status: data.requeue ? "pending" : data.deferred ? "deferred" : "error",
          ocr_error: data.error?.slice(0, 800) ?? "The local model could not read this file.",
          processed_at: new Date().toISOString(),
        })
        .eq("id", data.attachmentId);
    }

    const outcome = ok ? "done" : data.requeue ? "requeued" : data.deferred ? "deferred" : "error";

    if (data.runId) {
      await supabase.from("processing_events").insert({
        run_id: data.runId,
        import_id: data.importId,
        attachment_id: data.attachmentId,
        filename: data.filename,
        outcome,
        doc_type: extracted?.doc_type ?? null,
        confidence: extracted?.confidence ?? null,
        field_confidence: (extracted?.field_confidence ?? null) as unknown as Json,
        duration_ms: data.durationMs,
        error: data.error,
        model: data.model,
      });
    }

    return { outcome };
  });
