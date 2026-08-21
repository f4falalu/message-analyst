# Read documents on your own machine (Ollama / LM Studio / anything OpenAI-compatible)

Right now every page is read by a model call made from Lovable's servers. Those servers can't see anything running on your PC, so a `localhost` base URL saved under Models can be stored but never actually reached — which is why local hosting hasn't worked. Two ways to close that gap, and you get both.

## What changes for you

**1. "Read on this computer" lane (no tunnel, no exposure)**

- Each model entry under Models gets a **Where it runs** switch: *Lovable's servers* (today's behaviour) or *This computer*.
- With *This computer* selected, the browser tab does the reading: it pulls the file, sends it straight to your local endpoint (e.g. `http://localhost:11434/v1`), and only the extracted text/fields travel back to the archive. Zero credits used, nothing about your machine is exposed to the internet.
- The archive page grows a **Local lane** control next to the existing lanes: pick how many files to read at once, hit start, watch the same live feed. The tab has to stay open while it runs; closing it just pauses — already-read files stay read, the rest go back to waiting.
- A **Check connection** button verifies the endpoint is up and lists the models it can see, so a missing CORS setting or a stopped Ollama is reported in words, not as failed files.

**2. Tunnel option (keeps server-side reading)**

- If you'd rather expose the endpoint (ngrok, Cloudflare Tunnel, Tailscale Funnel), leave the switch on *Lovable's servers* and paste the public `https://…` URL. The Base URL field will reject `localhost`/`127.0.0.1` in that mode with an explanation, so the two setups can't be silently confused.

**3. Portable, dynamic setup**

- Nothing is hard-coded to one PC or one product. **Fetch available models** queries whatever endpoint you typed (Ollama, LM Studio, vLLM, llama.cpp, anything OpenAI-compatible) and fills the model dropdown from its own model list, so moving to another machine is: change the URL, refetch, pick a model.
- The existing backup-model chain and cooldown behaviour work the same for local models, and a local entry can list a cloud model as a last-resort backup (or vice-versa).
- Local models that can't take PDFs keep using the existing "held back" path instead of recording an empty read, and the setup screen states plainly that scans need a vision model.

## Setup notes shown in the app

A short panel on the Models page, kept generic:

- Ollama: `OLLAMA_ORIGINS=*` (or your preview URL) so the browser is allowed to call it; base URL `http://localhost:11434/v1`; a vision model such as `qwen2.5vl:7b` or `llama3.2-vision:11b` for scans.
- LM Studio: enable the local server, base URL `http://localhost:1234/v1`, CORS on.
- Any other server: OpenAI-compatible `/chat/completions` plus CORS for the browser lane.

## Technical notes

1. **Shared extraction core** — move the prompt, `normalise`, `parseJsonLoose`, and the request body builder out of `doc-reader.server.ts` into a client-safe `src/lib/doc-extract.ts`. The server reader and the new browser reader both call it, so there is exactly one prompt and one output shape.
2. **Schema** — add `run_location text not null default 'server'` (`'server' | 'browser'`) to `ai_providers`; save/read it in `src/lib/ai-settings.functions.ts`, which also enforces: server mode rejects loopback hosts, browser mode allows them. Grants unchanged.
3. **Browser lane** — new `src/lib/local-read.ts` (client): claims a slice of pending attachments through a server fn that returns signed URLs + chat context (reusing the existing claim/sign code paths and size bands), reads each with `doc-extract.ts` against the configured local base URL, then posts results to a new `saveLocalRead` server fn that writes `attachment` rows, `processing_events` (with the model id used) and rebuilds records exactly as `processBatch` does today — the persistence path stays server-side and identical.
4. **Model discovery** — `GET {baseUrl}/models`, falling back to Ollama's `/api/tags` when that 404s, called from the browser for local entries and from a server fn for public URLs.
5. **UI** — `src/routes/models.tsx`: run-location switch, connection check, model fetch, helper copy. `src/routes/archive.$importId.tsx`: local lane start/pause/concurrency reusing the existing lane UI and live feed; a warning when the active model is browser-hosted but the archive page isn't running the local lane.
6. **Failure handling** — a fetch failure to localhost is reported as "local model unreachable" and the file returns to waiting, never to `error`, so nothing gets marked as read-and-empty.
