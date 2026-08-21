// Server-only helpers for the extracted-ledger cache.
//
// Reading a page costs money and minutes, so every successful read is kept by
// filename+size. A stopped and restarted import fills those files straight
// from the cache and only sends the genuinely missing ones to a model.

import { contentKeyFor } from "./extraction-cache";
import type { ExtractedDoc } from "./doc-extract";
import type { Json } from "@/integrations/supabase/types";

type Db = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

/** Keep a successful read so the same document is never paid for twice. */
export async function rememberExtraction(
  supabase: Db,
  attachment: { filename: string; size_bytes?: number | null },
  extracted: ExtractedDoc,
  model: string | null,
  source: "server" | "browser",
): Promise<void> {
  try {
    await supabase.from("extraction_cache").upsert(
      {
        content_key: contentKeyFor(attachment.filename, attachment.size_bytes ?? null),
        filename: attachment.filename,
        size_bytes: attachment.size_bytes ?? null,
        raw_text: extracted.raw_text ?? null,
        extracted: extracted as unknown as Json,
        model,
        source,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "content_key" },
    );
  } catch {
    // The cache is an optimisation; never fail a good read because of it.
  }
}

/**
 * Fill every still-unread file in this import that has already been read
 * before (same name and size). Returns how many were restored.
 */
export async function applyCachedExtractions(
  supabase: Db,
  importId: string,
): Promise<{ restored: number; remaining: number }> {
  const { data: pending } = await supabase
    .from("attachments")
    .select("id, filename, size_bytes, ocr_status")
    .eq("import_id", importId)
    .in("ocr_status", ["pending", "error", "deferred"]);

  const rows = pending ?? [];
  if (rows.length === 0) return { restored: 0, remaining: 0 };

  const keys = Array.from(new Set(rows.map((r) => contentKeyFor(r.filename, r.size_bytes))));
  const cached = new Map<string, { raw_text: string | null; extracted: Json; model: string | null }>();

  // Chunked so a big import does not build a single enormous query.
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const { data } = await supabase
      .from("extraction_cache")
      .select("content_key, raw_text, extracted, model")
      .in("content_key", slice);
    for (const row of data ?? []) {
      cached.set(row.content_key, { raw_text: row.raw_text, extracted: row.extracted, model: row.model });
    }
  }

  let restored = 0;
  for (const row of rows) {
    const hit = cached.get(contentKeyFor(row.filename, row.size_bytes));
    if (!hit) continue;
    const { error } = await supabase
      .from("attachments")
      .update({
        ocr_status: "done",
        ocr_error: null,
        raw_text: hit.raw_text,
        extracted: hit.extracted,
        processed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (!error) restored += 1;
  }

  const { count } = await supabase
    .from("attachments")
    .select("id", { count: "exact", head: true })
    .eq("import_id", importId)
    .eq("ocr_status", "pending");

  return { restored, remaining: count ?? 0 };
}
