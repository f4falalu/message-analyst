# Stop skipping big files — read them on a dedicated heavy lane

Today a PDF over 6 MB is thrown out with "too large to read automatically". That file never gets read, so the cross-referencing step later reports "not found / not mentioned" as if the document said nothing — a wrong answer rather than a missing one.

The fix has two halves: actually read the big files, and never let an unread file masquerade as a read one.

## 1. Big files get their own lane instead of being dropped

- Work is split by size. The normal lanes claim only small attachments (under ~4 MB) and keep running 3-4 at a time in parallel, as now.
- A separate **heavy lane** claims one large attachment at a time. Because it is alone, the whole memory budget is available to it, so files that used to blow the worker now fit. Small-file lanes keep running in parallel next to it — nothing becomes sequential overall.
- The inline size ceiling rises from 6 MB to roughly 20 MB, and the base64 conversion is done incrementally so the file is never held twice in memory.

## 2. Anything still too big is *deferred*, not failed

- A file that exceeds even the heavy-lane ceiling gets the status **deferred — needs a bigger pass**, not "error" and not silently dropped.
- Deferred files stay claimable: raising the ceiling or retrying later picks them up with no re-run of everything else.

## 3. Matching can no longer confuse "unread" with "absent"

- Ledger building counts unread attachments (pending, processing, deferred, error) for the import.
- If any remain, the ledger banner says how many documents have not been read yet, and every record touching an unread file is flagged **Evidence incomplete — N attachment(s) not read yet** instead of "not found in the documents".
- Export carries the same flag, so a spreadsheet can never quietly claim something was missing when it was merely unprocessed.

## 4. Visibility

- The Files tab gains a **Deferred** filter and a size column, so the heavy queue is inspectable.
- The parse panel shows the heavy lane separately ("1 large file in progress") alongside the small-file lanes.

## Technical notes

- Migration: extend `claim_attachments` with `_min_bytes` / `_max_bytes` so lanes can claim by size band; add `deferred` as an accepted `ocr_status` value. No new tables.
- `src/lib/doc-reader.server.ts`: raise `MAX_PDF_BYTES` to 20 MB, throw a typed `DeferError` above it, and stream the base64 encode chunk-by-chunk without the intermediate `parts` array join.
- `src/lib/processing.functions.ts`: `processBatch` takes a size band; a `DeferError` writes `ocr_status: 'deferred'` with the reason rather than `error`. `buildLedger` computes the unread count and stamps an `evidence_incomplete` issue on affected records.
- `src/routes/archive.$importId.tsx`: one extra heavy-lane worker (chunk size 1) in the run loop, plus the Deferred filter, size column and unread-count banner.
- `src/lib/export-xlsx.ts`: include the evidence-incomplete flag in the issues column.
