# Bounce between OpenRouter models when rate limited

Today each saved model has exactly one model id. When OpenRouter returns a 429, the file just waits and retries the same model, then gets requeued. Instead, the reader should hop to the next model in a list and keep going.

## What changes for you

- On the Models page, an OpenRouter (or any OpenAI-compatible) entry gets a **Backup models** field: an ordered list of model ids to fall back to. The primary model stays the first choice.
- When a read hits a rate limit (429) or the model is unavailable, the next model in the list reads that file immediately — no waiting, no requeue.
- A model that just got rate limited is put on a short cooldown (about 60s) and skipped for other files during that window, so the whole run doesn't keep hammering it.
- The run log and per-file preview show which model actually read each file, so you can see the bouncing happening.
- Sensible OpenRouter defaults are pre-filled when you pick the OpenRouter preset (a few vision-capable models across different vendors), and free-tier variants can be included.

## Technical notes

1. **Storage**: add a `fallback_models text[]` column to `ai_providers` (default `{}`), with grants unchanged. Save/read it through `src/lib/ai-settings.functions.ts` (trim, cap at ~8 entries) and expose it in `src/routes/models.tsx` as a comma/newline separated textarea with helper text.
2. **Provider config**: `ProviderConfig` in `src/lib/ai-provider.server.ts` gains `models: string[]` = `[model, ...fallback_models]` deduped.
3. **Reader**: `readDocument` in `src/lib/doc-reader.server.ts` loops over `provider.models`:
   - Send OpenRouter's native `models` array too when the base URL is openrouter.ai, so OpenRouter itself can route around a dead upstream.
   - Catch 429/402-on-model/404-model-not-found/5xx and advance to the next id; honour `Retry-After` only when every id is exhausted.
   - Return the id that succeeded as `usedModel` on the extraction result.
4. **Cooldown**: a module-level `Map<modelId, timestampUntil>` in the server module marks rate-limited ids; the loop skips ids still cooling down and falls back to them only if nothing else is left. Per-worker, in-memory — no DB writes.
5. **Processing loop** (`src/lib/processing.functions.ts`): only treat a file as rate-limited/requeued after *all* models in the list fail; record `usedModel` in the `processing_events` row (append to `error`/notes field or a new `model` column on `processing_events`) and surface it in the Files/Live feed and preview panel.
6. Behaviour is unchanged for providers with no backup models configured.
