import { BlobReader, BlobWriter, TextWriter, ZipReader, type Entry } from "@zip.js/zip.js";
import { supabase } from "@/integrations/supabase/client";
import { guessMimeType, isReadable, parseChat } from "./wa-chat";

export type IngestProgress = {
  phase: "reading" | "parsing" | "uploading" | "indexing" | "paused" | "done";
  message: string;
  current: number;
  total: number;
  /** Bytes of attachment data already sent (and the total expected), for the byte-level bar. */
  bytesDone?: number;
  bytesTotal?: number;
};

/** A file that could not be uploaded, with the reason the last attempt gave. */
export type IngestFailure = { filename: string; reason: string };

/** Lets the UI pause or stop an upload that is already running. */
export type IngestControl = {
  isPaused: () => boolean;
  isCancelled: () => boolean;
};

const BUCKET = "wa-archive";
const UPLOAD_CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A durable marker for one zip's progress, kept in this browser. A tab crash or
 * a lost connection therefore never costs the work already done: picking the
 * same zip again continues the same import from the files still missing.
 */
export type ZipCheckpoint = {
  key: string;
  zipName: string;
  zipSize: number;
  importId: string | null;
  phase: IngestProgress["phase"];
  message: string;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  failed: number;
  updatedAt: number;
};

const CHECKPOINT_PREFIX = "zip-checkpoint:";

export function zipCheckpointKey(file: File): string {
  return `${CHECKPOINT_PREFIX}${file.name}:${file.size}`;
}

function writeCheckpoint(checkpoint: ZipCheckpoint) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(checkpoint.key, JSON.stringify(checkpoint));
  } catch {
    /* storage full or blocked — progress tracking is best-effort */
  }
}

export function readZipCheckpoint(file: File): ZipCheckpoint | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(zipCheckpointKey(file));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ZipCheckpoint;
  } catch {
    window.localStorage.removeItem(zipCheckpointKey(file));
    return null;
  }
}

/** Every unfinished zip this browser knows about, newest first. */
export function listZipCheckpoints(): ZipCheckpoint[] {
  if (typeof window === "undefined") return [];
  const out: ZipCheckpoint[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(CHECKPOINT_PREFIX)) continue;
    try {
      const value = JSON.parse(window.localStorage.getItem(key) ?? "") as ZipCheckpoint;
      if (value && value.phase !== "done") out.push(value);
    } catch {
      /* skip a corrupt entry */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearZipCheckpoint(key: string) {
  if (typeof window !== "undefined") window.localStorage.removeItem(key);
}




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

async function existingAttachmentNames(importId: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("attachments")
      .select("filename")
      .eq("import_id", importId)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const row of data) names.add(row.filename.toLowerCase());
    if (data.length < 1000) break;
  }
  return names;
}

export async function ingestZip(
  file: File,
  onProgress: (progress: IngestProgress) => void,
  options: { resumeImportId?: string; control?: IngestControl } = {},
): Promise<{
  importId: string;
  messages: number;
  attachments: number;
  readable: number;
  skipped: number;
  failed: IngestFailure[];
  cancelled: boolean;
}> {
  const control = options.control;
  const isCancelled = () => control?.isCancelled() === true;
  const isPaused = () => control?.isPaused() === true;

  // Every progress tick is mirrored into a checkpoint, so the last known
  // position of a multi-gigabyte archive survives a crash or a closed tab.
  const key = zipCheckpointKey(file);
  const saved = readZipCheckpoint(file);
  let checkpointImportId = options.resumeImportId ?? saved?.importId ?? null;
  let failedCount = 0;
  const emit = (progress: IngestProgress) => {
    onProgress(progress);
    writeCheckpoint({
      key,
      zipName: file.name,
      zipSize: file.size,
      importId: checkpointImportId,
      phase: progress.phase,
      message: progress.message,
      done: progress.current,
      total: progress.total,
      bytesDone: progress.bytesDone ?? 0,
      bytesTotal: progress.bytesTotal ?? 0,
      failed: failedCount,
      updatedAt: Date.now(),
    });
  };
  onProgress = emit;

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

  let importId: string;
  let alreadyParsed = false;
  // An explicit resume must find its import; a checkpoint-only guess quietly
  // falls back to a fresh import when that record has since been deleted.
  const resumeTarget = options.resumeImportId ?? checkpointImportId;
  const existingRow = resumeTarget
    ? await supabase.from("imports").select("id, chat_parsed, message_count").eq("id", resumeTarget).maybeSingle()
    : null;
  if (existingRow?.error) throw new Error(existingRow.error.message);
  if (options.resumeImportId && !existingRow?.data) {
    throw new Error("That import no longer exists — start a fresh upload.");
  }
  if (existingRow?.data) {
    const existing = existingRow.data;
    importId = existing.id;
    alreadyParsed = existing.chat_parsed === true && existing.message_count === parsed.messages.length;


    const { error: updateError } = await supabase
      .from("imports")
      .update({
        status: "uploading",
        total_files: mediaEntries.length,
        message_count: parsed.messages.length,
        chat_parsed: true,
        notes: null,
      })
      .eq("id", importId);
    if (updateError) throw new Error(updateError.message);
  } else {
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
    importId = importRow.id;
  }
  checkpointImportId = importId;


  try {
    // Messages + contacts first, so attachments can be linked by filename.
    // On a resume where the transcript is already stored, this whole stage is
    // skipped — the run picks up straight at the remaining attachments.
    if (alreadyParsed) {
      onProgress({
        phase: "indexing",
        message: `Transcript already saved — ${parsed.messages.length.toLocaleString()} messages kept.`,
        current: parsed.messages.length,
        total: parsed.messages.length,
      });
    } else {
      onProgress({
        phase: "indexing",
        message: `Saving ${parsed.messages.length.toLocaleString()} messages…`,
        current: 0,
        total: parsed.messages.length,
      });

      for (let i = 0; i < parsed.messages.length; i += 500) {
        const slice = parsed.messages.slice(i, i + 500);
        const { error } = await supabase.from("messages").upsert(
          slice.map((message) => ({
            import_id: importId,
            seq: message.seq,
            sent_at: message.sent_at,
            sender: message.sender,
            body: message.body,
            attachment_filename: message.attachment_filename,
          })),
          { onConflict: "import_id,seq", ignoreDuplicates: true },
        );
        if (error) throw new Error(error.message);
        onProgress({
          phase: "indexing",
          message: `Saving messages… ${Math.min(i + 500, parsed.messages.length).toLocaleString()} of ${parsed.messages.length.toLocaleString()}`,
          current: Math.min(i + 500, parsed.messages.length),
          total: parsed.messages.length,
        });
      }

      await supabase.from("contacts").delete().eq("import_id", importId);
      if (parsed.contacts.length) {
        const { error } = await supabase.from("contacts").insert(
          parsed.contacts.map((contact) => ({ ...contact, import_id: importId })),
        );
        if (error) throw new Error(error.message);
      }
    }


    const seqByFilename = new Map<string, number>();
    for (const message of parsed.messages) {
      if (message.attachment_filename) {
        seqByFilename.set(baseName(message.attachment_filename).toLowerCase(), message.seq);
      }
    }

    // Anything already stored from an earlier attempt is left alone, so an
    // interrupted upload picks up where it stopped.
    onProgress({
      phase: "uploading",
      message: "Checking which files are already uploaded…",
      current: 0,
      total: mediaEntries.length,
    });
    const alreadyStored = await existingAttachmentNames(importId);

    const todo = mediaEntries.filter((entry) => !alreadyStored.has(baseName(entry.filename).toLowerCase()));
    const skipped = mediaEntries.length - todo.length;
    if (skipped > 0) {
      onProgress({
        phase: "uploading",
        message: `Resuming — ${skipped.toLocaleString()} files are already uploaded.`,
        current: skipped,
        total: mediaEntries.length,
      });
    }

    // Stream each media entry straight from the zip to storage.
    type Row = {
      import_id: string;
      filename: string;
      storage_path: string;
      mime_type: string;
      size_bytes: number;
      message_seq: number | null;
      ocr_status: string;
    };

    let uploaded = 0;
    let readable = 0;
    let saved = 0;
    let bytesDone = 0;
    const entrySize = (entry: Entry) => Number((entry as { uncompressedSize?: number }).uncompressedSize ?? 0);
    const bytesTotal = mediaEntries.reduce((sum, entry) => sum + entrySize(entry), 0);
    const skippedBytes = mediaEntries
      .filter((entry) => alreadyStored.has(baseName(entry.filename).toLowerCase()))
      .reduce((sum, entry) => sum + entrySize(entry), 0);
    bytesDone = skippedBytes;
    const failed: IngestFailure[] = [];
    let pending: Row[] = [];
    let flushing: Promise<void> = Promise.resolve();

    const saveRows = async (batch: Row[]) => {
      if (batch.length === 0) return;
      for (let attempt = 1; ; attempt += 1) {
        const { error } = await supabase
          .from("attachments")
          .upsert(batch, { onConflict: "import_id,filename", ignoreDuplicates: true });
        if (!error) break;
        if (attempt >= MAX_ATTEMPTS) throw new Error(error.message);
        await sleep(500 * attempt);
      }
      saved += batch.length;
    };

    // Rows are written in small batches as files land, so an interrupted run
    // keeps everything already uploaded and resumes from there.
    const flush = (force: boolean) => {
      if (pending.length === 0 || (!force && pending.length < 25)) return;
      const batch = pending;
      pending = [];
      flushing = flushing.then(() => saveRows(batch));
    };

    const report = () => {
      const done = uploaded + skipped + failed.length;
      onProgress({
        phase: "uploading",
        message:
          `Uploading attachments… ${done.toLocaleString()} of ${mediaEntries.length.toLocaleString()}` +
          (failed.length ? ` · ${failed.length.toLocaleString()} failed, will retry on resume` : ""),
        current: done,
        total: mediaEntries.length,
        bytesDone,
        bytesTotal,
      });
    };

    // Pause simply idles the workers between files; cancel lets them finish the
    // file in flight and stop, so nothing is left half-written.
    const waitWhilePaused = async () => {
      let announced = false;
      while (isPaused() && !isCancelled()) {
        if (!announced) {
          announced = true;
          const done = uploaded + skipped + failed.length;
          onProgress({
            phase: "paused",
            message: `Paused — ${done.toLocaleString()} of ${mediaEntries.length.toLocaleString()} files uploaded.`,
            current: done,
            total: mediaEntries.length,
            bytesDone,
            bytesTotal,
          });
        }
        await sleep(300);
      }
      if (announced && !isCancelled()) report();
    };

    await runPool(todo, UPLOAD_CONCURRENCY, async (entry) => {
      await waitWhilePaused();
      if (isCancelled()) return;

      const getData = (entry as unknown as { getData?: (writer: BlobWriter) => Promise<Blob> }).getData;
      if (!getData) return;
      const filename = baseName(entry.filename);
      const mime = guessMimeType(filename);
      const storagePath = `${importId}/${filename}`;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const blob = await getData.call(entry, new BlobWriter(mime));
          const { error } = await supabase.storage.from(BUCKET).upload(storagePath, blob, {
            contentType: mime,
            upsert: true,
          });
          if (error && !/already exists/i.test(error.message)) throw new Error(error.message);

          const canRead = isReadable(mime);
          if (canRead) readable += 1;
          pending.push({
            import_id: importId,
            filename,
            storage_path: storagePath,
            mime_type: mime,
            size_bytes: blob.size,
            message_seq: seqByFilename.get(filename.toLowerCase()) ?? null,
            ocr_status: canRead ? "pending" : "skipped",
          });
          uploaded += 1;
          bytesDone += blob.size;
          flush(false);
          break;
        } catch (uploadError) {
          if (attempt === MAX_ATTEMPTS) {
            // One bad file must not sink the whole import — note it and move on.
            failed.push({
              filename,
              reason: uploadError instanceof Error ? uploadError.message : String(uploadError),
            });
            bytesDone += entrySize(entry);
            failedCount = failed.length;
            break;
          }
          if (isCancelled()) break;
          await sleep(600 * 2 ** (attempt - 1));
        }
      }

      if ((uploaded + failed.length) % 5 === 0) report();
    });

    flush(true);
    await flushing;
    report();

    const cancelled = isCancelled();
    const remaining = mediaEntries.length - (uploaded + skipped);

    await supabase
      .from("imports")
      .update({
        status: cancelled || failed.length ? "uploading" : "processing",
        total_files: mediaEntries.length,
        notes: cancelled
          ? `Upload cancelled — ${remaining.toLocaleString()} file(s) left; resume to continue.`
          : failed.length
            ? `${failed.length} file(s) failed to upload — last error: ${failed[failed.length - 1]?.reason ?? "unknown"}`
            : null,
      })
      .eq("id", importId);

    onProgress({
      phase: "done",
      message: cancelled
        ? `Upload cancelled — ${(uploaded + skipped).toLocaleString()} file(s) saved.`
        : failed.length
          ? `Upload finished with ${failed.length} failed file(s).`
          : "Upload complete.",
      current: 1,
      total: 1,
    });

    return {
      importId,
      messages: parsed.messages.length,
      attachments: saved,
      readable,
      skipped,
      failed,
      cancelled,
    };


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
