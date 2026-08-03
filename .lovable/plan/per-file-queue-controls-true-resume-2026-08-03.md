# Per-file queue controls + true resume

Two problems to solve:

1. Failed or stuck files can only be retried by re-running a whole batch — there is no per-file "send this one back to the queue" action on the upload/parse side.
2. Resuming an import feels like starting over: after picking the zip again, the app re-parses the transcript and re-writes all ~13,000 messages and contacts before it even reaches the attachment phase, and the progress bar only starts reflecting already-uploaded files after that long silent stage.

## What will change

### 1. Resume actually resumes

- On resume, check the import first: if the transcript was already parsed and the stored message count matches the zip's parsed count, skip the message and contact re-write entirely and jump straight to attachments.
- Stop deleting and re-inserting contacts on every resume; only write them when the transcript stage actually runs.
- Show the resume state immediately: before uploading, the progress bar starts at "N of M files already uploaded" instead of 0, and the reading/parsing stage reports its own progress instead of appearing frozen.
- Remember the last import per zip filename in browser storage, so choosing the same zip again auto-selects "resume this import" rather than creating a new one.

Note: browsers cannot keep a 2.9 GB file between page loads, so the zip must be re-selected. Everything after that selection is skipped work, not repeated work.

### 2. Per-file controls

On the import/archive screen, add a **Files** view listing every attachment with its state (uploaded, pending, processing, done, error, skipped), filename, size and last error.

Per row:
- **Requeue** — sets the file back to pending so the next parse run picks it up.
- **Reprocess now** — runs extraction on just that file immediately (already exists in the run log; exposed here too).
- **Mark skipped** — for junk files that should stop being retried.

Bulk actions above the list:
- **Requeue all failed**, **Requeue stuck** (files left in "processing" from a crashed run), and a filter by state.

Files missing from storage (a row that never finished uploading) are flagged as **Not uploaded** and are picked up automatically on the next zip resume.

### 3. Pause / resume the parse run

The upload panel already has pause/resume/cancel. The same controls will be added to the parse (OCR/extraction) run:
- **Pause** stops claiming new chunks; files in flight finish and save.
- **Resume** continues from the queue — nothing already parsed is redone.
- Pause state survives a page reload, so closing the tab mid-run leaves the queue intact rather than orphaning files in "processing".

## Technical notes

- `src/lib/ingest.ts`: add a fast path that skips the messages/contacts stage when the import row already has `chat_parsed` and a matching `message_count`; emit progress for the reading/parsing stage; seed the upload progress with the already-stored count.
- `src/routes/index.tsx`: persist `{ zip filename+size -> importId }` in `localStorage` so reselecting the same zip preselects resume.
- `src/lib/processing.functions.ts`: add `requeueAttachments` (by ids or by state: `error` / stale `processing`) and `setAttachmentSkipped`; both write a `processing_events` entry so the run log records the manual action.
- Stale-`processing` detection: rows in `processing` whose run finished or whose claim is older than a few minutes.
- New Files tab in `src/routes/archive.$importId.tsx` with state filter, paginated list, and the row/bulk actions above; parse-run pause flag held in component state plus `localStorage` and checked between chunk claims.
- No schema change needed — `attachments.ocr_status`, `ocr_error` and `processing_events` already cover this.
