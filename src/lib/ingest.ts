import { BlobReader, BlobWriter, TextWriter, ZipReader, type Entry } from "@zip.js/zip.js";
import { supabase } from "@/integrations/supabase/client";
import { guessMimeType, isReadable, parseChat } from "./wa-chat";

export type IngestProgress = {
  phase: "reading" | "parsing" | "uploading" | "indexing" | "done";
  message: string;
  current: number;
  total: number;
};

const BUCKET = "wa-archive";
const UPLOAD_CONCURRENCY = 4;

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    }),
  );
}

export async function ingestZip(
  file: File,
  onProgress: (progress: IngestProgress) => void,
): Promise<{ importId: string; messages: number; attachments: number; readable: number }> {

  onProgress({ phase: "reading", message: "Opening the zip file…", current: 0, total: 0 });

  const reader = new ZipReader(new BlobReader(file));
  const entries = (await reader.getEntries()).filter((entry) => !entry.directory);

  const chatEntry =
    entries.find((entry) => /(^|\/)_chat\.txt$/i.test(entry.filename)) ??
    entries.find((entry) => /\.txt$/i.test(entry.filename));
  if (!chatEntry?.getData) {
    await reader.close();
    throw new Error("No chat transcript (_chat.txt) found inside this zip.");
  }

  onProgress({ phase: "parsing", message: "Reading the conversation…", current: 0, total: 0 });
  const chatText = await chatEntry.getData(new TextWriter());
  const parsed = parseChat(chatText);

  const mediaEntries = entries.filter((entry) => entry !== chatEntry);

  const { data: importRow, error: importError } = await supabase
    .from("imports")
    .insert({
      filename: file.name,
      status: "uploading",
      total_files: mediaEntries.length,
      message_count: parsed.messages.length,
      chat_parsed: true,
    })
    .select("id")
    .single();
  if (importError || !importRow) throw new Error(importError?.message ?? "Could not create the import.");
  const importId = importRow.id;

  try {
    // Messages + contacts first, so attachments can be linked by filename.
    onProgress({
      phase: "indexing",
      message: `Saving ${parsed.messages.length.toLocaleString()} messages…`,
      current: 0,
      total: parsed.messages.length,
    });

    for (let i = 0; i < parsed.messages.length; i += 500) {
      const slice = parsed.messages.slice(i, i + 500);
      const { error } = await supabase.from("messages").insert(
        slice.map((message) => ({
          import_id: importId,
              seq: message.seq,
          sent_at: message.sent_at,
          sender: message.sender,
          body: message.body,
          attachment_filename: message.attachment_filename,
        })),
      );
      if (error) throw new Error(error.message);
      onProgress({
        phase: "indexing",
        message: `Saving messages… ${Math.min(i + 500, parsed.messages.length).toLocaleString()} of ${parsed.messages.length.toLocaleString()}`,
        current: Math.min(i + 500, parsed.messages.length),
        total: parsed.messages.length,
      });
    }

    if (parsed.contacts.length) {
      const { error } = await supabase.from("contacts").insert(
        parsed.contacts.map((contact) => ({ ...contact, import_id: importId })),
      );
      if (error) throw new Error(error.message);
    }

    const seqByFilename = new Map<string, number>();
    for (const message of parsed.messages) {
      if (message.attachment_filename) {
        seqByFilename.set(baseName(message.attachment_filename).toLowerCase(), message.seq);
      }
    }

    // Stream each media entry straight from the zip to storage.
    let uploaded = 0;
    let readable = 0;
    const rows: {
      import_id: string;
      filename: string;
      storage_path: string;
      mime_type: string;
      size_bytes: number;
      message_seq: number | null;
      ocr_status: string;
    }[] = [];

    await runPool(mediaEntries, UPLOAD_CONCURRENCY, async (entry) => {
      const getData = (entry as unknown as { getData?: (writer: BlobWriter) => Promise<Blob> }).getData;
      if (!getData) return;
      const filename = baseName(entry.filename);
      const mime = guessMimeType(filename);
      const blob = await getData.call(entry, new BlobWriter(mime));

      const storagePath = `${importId}/${filename}`;

      const { error } = await supabase.storage.from(BUCKET).upload(storagePath, blob, {
        contentType: mime,
        upsert: true,
      });
      if (error && !/already exists/i.test(error.message)) throw new Error(error.message);

      const canRead = isReadable(mime);
      if (canRead) readable += 1;
      rows.push({
        import_id: importId,
          filename,
        storage_path: storagePath,
        mime_type: mime,
        size_bytes: blob.size,
        message_seq: seqByFilename.get(filename.toLowerCase()) ?? null,
        ocr_status: canRead ? "pending" : "skipped",
      });

      uploaded += 1;
      if (uploaded % 5 === 0 || uploaded === mediaEntries.length) {
        onProgress({
          phase: "uploading",
          message: `Uploading attachments… ${uploaded.toLocaleString()} of ${mediaEntries.length.toLocaleString()}`,
          current: uploaded,
          total: mediaEntries.length,
        });
      }
    });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("attachments").insert(rows.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }

    await supabase
      .from("imports")
      .update({ status: "processing", total_files: mediaEntries.length })
      .eq("id", importId);

    onProgress({ phase: "done", message: "Upload complete.", current: 1, total: 1 });

    return { importId, messages: parsed.messages.length, attachments: rows.length, readable };
  } catch (error) {
    await supabase
      .from("imports")
      .update({ status: "error", notes: error instanceof Error ? error.message.slice(0, 500) : null })
      .eq("id", importId);
    throw error;
  } finally {
    await reader.close();
  }
}
