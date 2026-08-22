// Browser side of the "read on this computer" lane.
//
// Runs in the tab, so it can talk to Ollama / LM Studio / vLLM / llama.cpp on
// localhost. Only the extracted fields travel back to the archive; the machine
// itself is never exposed to the internet.

import {
  buildChatBody,
  bytesToBase64,
  normalise,
  parseJsonLoose,
  userTextFor,
  type ExtractedDoc,
} from "./doc-extract";
import type { LocalJob, LocalProviderInfo } from "./local-read.functions";

/** The endpoint could not be reached at all — the file stays "waiting". */
export class LocalUnreachableError extends Error {
  readonly unreachable = true;
  constructor(baseUrl: string, detail: string) {
    super(
      `Could not reach the model on this computer (${baseUrl}): ${detail}. Check it is running and that it allows requests from this page.`,
    );
    this.name = "LocalUnreachableError";
  }
}

/** The file is deliberately left unread (not empty) for a later pass. */
export class LocalDeferError extends Error {
  readonly deferred = true;
  constructor(message: string) {
    super(message);
    this.name = "LocalDeferError";
  }
}

const MAX_LOCAL_BYTES = 20 * 1024 * 1024;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** True when this page is served over https but the endpoint is plain http. */
export function isMixedContent(baseUrl: string): boolean {
  if (typeof window === "undefined") return false;
  return window.location.protocol === "https:" && /^http:\/\//i.test(baseUrl.trim());
}

/**
 * A browser on an https page refuses plain-http calls to a machine on the local
 * network (mixed content / private network access), and the failure surfaces as
 * a bare "Failed to fetch" with no further detail. Say what actually happened.
 */
function explainFailure(baseUrl: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : "no response";
  if (isMixedContent(baseUrl)) {
    return `${detail} — this page is served over https, and browsers block plain http calls to your computer. Either open this app over http (or a localhost dev URL), or put Ollama behind an https address (e.g. a Cloudflare/ngrok tunnel) and paste that URL here`;
  }
  return detail;
}

/** Same endpoint, alternate loopback spellings — some setups only bind one. */
function candidateBases(baseUrl: string): string[] {
  const base = trimBase(baseUrl);
  const out = [base];
  if (/\/\/localhost[:/]/i.test(base)) out.push(base.replace("//localhost", "//127.0.0.1"));
  else if (/\/\/127\.0\.0\.1[:/]/.test(base)) out.push(base.replace("//127.0.0.1", "//localhost"));
  return out;
}

/**
 * ngrok's free tier serves an interstitial "warning" page to browser-like
 * requests unless this header is present. It is harmless to every other server
 * (Ollama, LM Studio, cloudflared), so we send it only when the host is ngrok
 * to avoid forcing a CORS preflight on plain localhost endpoints.
 */
function tunnelHeaders(baseUrl: string): Record<string, string> {
  try {
    if (/ngrok/i.test(new URL(baseUrl).hostname)) {
      return { "ngrok-skip-browser-warning": "skip" };
    }
  } catch {
    /* not a URL — ignore */
  }
  return {};
}

/** Whatever this endpoint says it can serve — OpenAI shape first, Ollama second. */
export async function listLocalModels(baseUrl: string): Promise<string[]> {
  const ids: string[] = [];
  let lastError: unknown = null;

  for (const base of candidateBases(baseUrl)) {
    try {
      const res = await fetch(`${base}/models`, { headers: tunnelHeaders(base) });
      if (res.ok) {
        const payload = (await res.json()) as { data?: { id?: string }[] };
        for (const entry of payload.data ?? []) if (entry.id) ids.push(entry.id);
      }
    } catch (error) {
      lastError = error;
    }
    if (ids.length === 0) {
      // Ollama's own listing lives outside the /v1 compatibility path.
      const root = base.replace(/\/v1$/, "");
      try {
        const res = await fetch(`${root}/api/tags`, { headers: tunnelHeaders(base) });
        if (res.ok) {
          const payload = (await res.json()) as { models?: { name?: string }[] };
          for (const entry of payload.models ?? []) if (entry.name) ids.push(entry.name);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (ids.length > 0) break;
  }

  if (ids.length === 0 && lastError) {
    throw new LocalUnreachableError(trimBase(baseUrl), explainFailure(baseUrl, lastError));
  }
  return Array.from(new Set(ids));
}


/**
 * Model ids that can actually look at a scan. Text-only models silently return
 * nothing useful, so a run should never start on one.
 */
const VISION_HINTS =
  /(vl|vision|llava|bakllava|moondream|minicpm-v|internvl|pixtral|gemma3|granite3\.?2-vision|qwen2\.?5vl|qwen3-vl|llama3\.2-vision|gpt-4o|gemini|claude|florence|docling|got-ocr|nanonets)/i;

export function isVisionModel(id: string): boolean {
  return VISION_HINTS.test(id);
}

export type EndpointCheck = {
  ok: boolean;
  models: string[];
  visionModels: string[];
  detail: string;
};

/**
 * Verify a local endpoint before a run: is it reachable, and does it serve at
 * least one model that can read a picture?
 */
export async function checkLocalEndpoint(baseUrl: string): Promise<EndpointCheck> {
  try {
    const models = await listLocalModels(baseUrl);
    const visionModels = models.filter(isVisionModel);
    if (models.length === 0) {
      return {
        ok: false,
        models,
        visionModels,
        detail: "Reachable, but it listed no models. Pull or load a vision model first.",
      };
    }
    if (visionModels.length === 0) {
      return {
        ok: false,
        models,
        visionModels,
        detail: `Reachable with ${models.length} model${models.length === 1 ? "" : "s"}, but none of them can read pictures. Pull a vision model (e.g. qwen2.5vl:7b or llama3.2-vision:11b) before starting a run.`,
      };
    }
    return {
      ok: true,
      models,
      visionModels,
      detail: `Reachable — ${visionModels.length} vision-capable model${visionModels.length === 1 ? "" : "s"} of ${models.length} available (${visionModels.slice(0, 3).join(", ")}).`,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      visionModels: [],
      detail: error instanceof Error ? error.message : "No response.",
    };
  }
}

/**
 * Pull an Ollama tag (e.g. "qwen2.5vl:7b") onto this machine, reporting
 * progress lines as they stream in. Returns the exact tag now available so it
 * can be pinned as the model used for reading.
 */
export async function pullOllamaModel(
  baseUrl: string,
  tag: string,
  onProgress?: (line: string) => void,
): Promise<string> {
  const root = trimBase(baseUrl).replace(/\/v1$/, "");
  const wanted = tag.trim();
  if (!wanted) throw new Error("Type the model tag you want to pull, e.g. qwen2.5vl:7b");

  let res: Response;
  try {
    res = await fetch(`${root}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tunnelHeaders(root) },
      body: JSON.stringify({ model: wanted, stream: true }),
    });
  } catch (error) {
    throw new LocalUnreachableError(root, error instanceof Error ? error.message : "no response");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama refused the pull (${res.status}): ${text.slice(0, 300)}`);
  }

  const reader = res.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line) as { status?: string; error?: string };
          if (payload.error) throw new Error(payload.error);
          if (payload.status) onProgress?.(payload.status);
        } catch (error) {
          if (error instanceof Error && !(error instanceof SyntaxError)) throw error;
        }
      }
    }
  }

  // Pin whatever tag the machine actually ended up with (":latest" is implied).
  const available = await listLocalModels(baseUrl);
  return (
    available.find((id) => id === wanted) ??
    available.find((id) => id === `${wanted}:latest`) ??
    available.find((id) => id.startsWith(`${wanted}:`)) ??
    wanted
  );
}


async function mediaBlockFor(job: LocalJob, supportsPdf: boolean): Promise<Record<string, unknown>> {
  const isPdf = (job.mimeType ?? "") === "application/pdf";
  if (isPdf && !supportsPdf) {
    throw new LocalDeferError(
      "This local model is set up for images only, so the PDF has not been read yet. Use a PDF-capable model (or the cloud lane) and queue it again.",
    );
  }

  let res: Response;
  try {
    res = await fetch(job.signedUrl);
  } catch (error) {
    throw new Error(
      `Could not download the file from the archive: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  if (!res.ok) throw new Error(`Could not download the file from the archive (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_LOCAL_BYTES) {
    throw new LocalDeferError(
      `File is larger than the local reading limit (${(bytes.length / 1024 / 1024).toFixed(1)} MB). Held back — it has not been read yet.`,
    );
  }
  const base64 = bytesToBase64(bytes);

  if (isPdf) {
    return {
      type: "file",
      file: { filename: job.filename, file_data: `data:application/pdf;base64,${base64}` },
    };
  }
  const mime = job.mimeType && job.mimeType.startsWith("image/") ? job.mimeType : "image/jpeg";
  return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
}

/** Read one document with the model running on this machine. */
export async function readWithLocalModel(
  provider: Pick<LocalProviderInfo, "baseUrl" | "models" | "supportsPdf">,
  job: LocalJob,
): Promise<{ extracted: ExtractedDoc; model: string }> {
  const base = trimBase(provider.baseUrl);
  const mediaBlock = await mediaBlockFor(job, provider.supportsPdf);
  const userText = userTextFor(job.chatContext);
  const order = provider.models.filter(Boolean);
  if (order.length === 0) throw new Error("No model id is configured for this local endpoint.");

  let lastError: Error | null = null;

  for (let index = 0; index < order.length; index += 1) {
    const model = order[index]!;
    const isLast = index === order.length - 1;
    let response: Response;
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tunnelHeaders(base) },
        body: JSON.stringify(buildChatBody({ model, userText, mediaBlock })),
      });
    } catch (error) {
      // A local endpoint that does not answer is a setup problem, not a bad file.
      throw new LocalUnreachableError(base, error instanceof Error ? error.message : "no response");
    }

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(`Local model failed [${response.status}] on ${model}: ${text.slice(0, 400)}`);
      if (!isLast) continue;
      throw lastError;
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    if (!content) {
      lastError = new Error(`${model} returned an empty response.`);
      if (!isLast) continue;
      throw lastError;
    }
    return { extracted: normalise(parseJsonLoose(content)), model: payload.model || model };
  }

  throw lastError ?? new Error("The document could not be read on this computer.");
}
