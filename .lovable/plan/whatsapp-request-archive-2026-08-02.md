# WhatsApp Request Archive

Turn a year's WhatsApp export (chat + ~3,936 attachments, ~2.9GB) into a searchable, editable archive of procurement requests, with Excel export.

## What you'll be able to do

1. Drag the export `.zip` onto the upload page. Nothing is uploaded whole — the browser opens the zip locally and streams its contents up piece by piece, so a 2.9GB file works.
2. Watch a live progress dashboard: files uploaded, messages parsed, attachments read, records extracted.
3. Browse the resulting archive in a table you can search, filter by facility/date/status, sort, and correct by hand.
4. Open any record to see the original chat messages and the attachment images/PDFs it was built from.
5. Export everything (or the current filter) to Excel.

## Columns in the archive

Facility name · Items (with quantities) · Amount paid · Date of request · Date of payment · Requester name · Requester phone · Status (requested / paid / unclear) · Confidence · Source message refs · Source attachment refs

Every extracted field keeps a link back to its source so anything questionable can be verified fast.

## How processing works

Stage 1 — Ingest (browser)
- Zip is read client-side with a streaming reader; no 2.9GB server upload.
- `_chat.txt` is uploaded first, then attachments are pushed to cloud storage in parallel batches with resume support, so a dropped connection doesn't restart the job.

Stage 2 — Parse chat
- Server splits `_chat.txt` into messages (timestamp, sender, body, attachment reference).
- Senders are resolved into a contacts list (name + phone from the export).

Stage 3 — Read attachments
- Every photo and CamScanner PDF is sent to an AI vision model for OCR + structured extraction (facility, items, quantities, totals, dates, receipt vs request).
- PDFs are converted page-by-page before OCR.
- Processed in a resumable background queue with concurrency limits and retries; you can close the tab and come back.

Stage 4 — Cross-reference
- Each attachment is joined to the chat messages around it (same sender, nearby timestamp) and grouped into one *request record*.
- Payment confirmations (receipts, "paid" messages) are matched back to their request by facility + amount + proximity, filling the payment date.
- Anything ambiguous is flagged `needs review` rather than guessed silently.

Stage 5 — Review & export
- Archive table with inline editing, review queue for flagged rows, and `.xlsx` export.

## Technical notes

- Backend: Lovable Cloud (Postgres + storage + auth). Tables: `imports`, `messages`, `attachments`, `contacts`, `request_records`, `record_sources`.
- Zip handling: `zip.js` streaming reader in a Web Worker; per-file signed upload URLs; upload state persisted so refresh resumes.
- OCR/extraction: Lovable AI vision model with a strict JSON schema per document; results stored raw alongside the parsed fields.
- Chat parsing runs server-side in chunks; attachment OCR runs as a queued job table drained by a worker endpoint, batched and rate-limit aware.
- Export via a server function generating `.xlsx`.
- Access is gated by login so the archive isn't public.

## Things to know up front

- Running vision extraction across ~3,936 attachments is a large AI workload — it will take a while and consume a meaningful amount of AI credits. The queue shows progress and cost as it runs, and can be paused.
- Uploading ~2.9GB depends on your connection; the resumable queue means it can be done across sessions.
- Suggestion: the first run processes a sample (e.g. 50 attachments) so you can check the extracted columns look right before committing to the full batch.

## Build order

1. Cloud setup: auth, schema, storage bucket.
2. Upload page with streaming zip reader + resumable uploads + progress.
3. Chat parser and contacts resolution.
4. Attachment OCR queue with sample-run mode.
5. Cross-reference/record builder with confidence flags.
6. Archive table: search, filters, inline edit, source viewer.
7. Excel export.
