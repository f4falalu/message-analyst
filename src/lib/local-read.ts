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
import { pdfToImageDataUrls } from "./pdf-raster";
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

const MAX_LOCAL_BYTES = 60 * 1024 * 1024;
// The hosting ingress sits in front of the relay route and rejects oversized
// JSON before route code runs. This leaves room for prompt/context JSON too.
const MAX_LOCAL_IMAGE_DATA_URL_CHARS = 560_000;
// Pages of one document are read a few at a time: fast without overwhelming a
// single local runtime, which serialises inference anyway.
const PAGE_CONCURRENCY = 3;

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

/** ngrok's free tier can serve a browser warning page in place of the API. */
export class TunnelInterstitialError extends Error {
  constructor(base: string) {
    super(
      `The tunnel at ${base} returned ngrok's browser warning page instead of the model API. ` +
        `The app could not bypass ngrok's browser warning page.`,
    );
    this.name = "TunnelInterstitialError";
  }
}

function isInterstitial(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/html");
}

async function fetchApi(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  if (/\.ngrok-free\.(app|dev)$/i.test(parsed.hostname)) {
    return fetch(`/api/public/local-model-relay?target=${encodeURIComponent(url)}`, init);
  }
  const res = await fetch(url, init);
  if (!isInterstitial(res)) return res;
  const retry = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), "ngrok-skip-browser-warning": "true" },
  });
  if (isInterstitial(retry)) throw new TunnelInterstitialError(trimBase(url));
  return retry;
}

async function responseError(res: Response): Promise<Error> {
  const text = await res.text();
  try {
    const payload = JSON.parse(text) as { error?: string };
    if (payload.error) return new Error(payload.error);
  } catch {
    // Preserve the status fallback when an endpoint returns non-JSON text.
  }
  return new Error(`Endpoint returned ${res.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
}

/** Whatever this endpoint says it can serve — OpenAI shape first, Ollama second. */
export async function listLocalModels(baseUrl: string): Promise<string[]> {
  const ids: string[] = [];
  let lastError: unknown = null;

  for (const base of candidateBases(baseUrl)) {
    try {
      const res = await fetchApi(`${base}/models`);
      if (res.ok) {
        const payload = (await res.json()) as { data?: { id?: string }[] };
        for (const entry of payload.data ?? []) if (entry.id) ids.push(entry.id);
      } else lastError = await responseError(res);
    } catch (error) {
      lastError = error;
    }
    if (ids.length === 0) {
      // Ollama's own listing lives outside the /v1 compatibility path.
      const root = base.replace(/\/v1$/, "");
      try {
        const res = await fetchApi(`${root}/api/tags`);
        if (res.ok) {
          const payload = (await res.json()) as { models?: { name?: string }[] };
          for (const entry of payload.models ?? []) if (entry.name) ids.push(entry.name);
        } else lastError = await responseError(res);
      } catch (error) {
        lastError = error;
      }
    }
    if (ids.length > 0) break;
  }

  if (ids.length === 0 && lastError) {
    if (lastError instanceof TunnelInterstitialError) throw lastError;
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
    res = await fetchApi(`${root}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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


async function mediaBlocksFor(job: LocalJob): Promise<Record<string, unknown>[]> {
  const isPdf = (job.mimeType ?? "") === "application/pdf";

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
  if (isPdf) {
    // Local runtimes reject PDF attachments outright ("invalid message
    // format"), so the tab renders the pages and sends pictures instead.
    let pages: string[];
    try {
      pages = await pdfToImageDataUrls(bytes);
    } catch (error) {
      throw new LocalDeferError(
        `The PDF could not be turned into pages on this computer (${
          error instanceof Error ? error.message : "render failed"
        }). Held back — it has not been read yet.`,
      );
    }
    return pages.map((url) => ({ type: "image_url", image_url: { url } }));
  }

  const mime = job.mimeType && job.mimeType.startsWith("image/") ? job.mimeType : "image/jpeg";
  const blob = new Blob([bytes], { type: mime });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    const rawUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
    if (rawUrl.length > MAX_LOCAL_IMAGE_DATA_URL_CHARS) {
      throw new LocalDeferError(
        "The image could not be compressed safely for the local connection. It will be retried in the cloud lane.",
      );
    }
    return [{ type: "image_url", image_url: { url: rawUrl } }];
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    let scale = Math.min(1, 1600 / longest);
    let quality = 0.78;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the image.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_LOCAL_IMAGE_DATA_URL_CHARS) {
        return [{ type: "image_url", image_url: { url } }];
      }
      scale *= 0.82;
      quality = Math.max(0.38, quality - 0.06);
    }
  } finally {
    bitmap.close();
  }

  throw new LocalDeferError("The image could not be prepared for the local model.");
}

function mergePageExtractions(pages: ExtractedDoc[]): ExtractedDoc {
  const firstString = (key: keyof ExtractedDoc): string | null => {
    for (const page of pages) {
      const value = page[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  };
  const lastNumber = (key: "total_amount"): number | null => {
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      const value = pages[index]?.[key];
      if (typeof value === "number") return value;
    }
    return null;
  };
  const confidenceFor = (key: keyof ExtractedDoc["field_confidence"]): number | null => {
    const values = pages
      .map((page) => page.field_confidence[key])
      .filter((value): value is number => typeof value === "number");
    return values.length > 0 ? Math.max(...values) : null;
  };
  const type = pages.find((page) => page.doc_type !== "other")?.doc_type ?? "other";

  return {
    doc_type: type,
    facility_name: firstString("facility_name"),
    items: pages.flatMap((page) => page.items),
    total_amount: lastNumber("total_amount"),
    currency: firstString("currency"),
    document_date: firstString("document_date"),
    payment_date: firstString("payment_date"),
    contact_name: firstString("contact_name"),
    contact_phone: firstString("contact_phone"),
    reference: firstString("reference"),
    raw_text: pages
      .map((page, index) => `Page ${index + 1}\n${page.raw_text}`)
      .join("\n\n")
      .slice(0, 8000),
    confidence: pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length,
    field_confidence: {
      facility_name: confidenceFor("facility_name"),
      items: confidenceFor("items"),
      total_amount: confidenceFor("total_amount"),
      document_date: confidenceFor("document_date"),
      payment_date: confidenceFor("payment_date"),
      contact: confidenceFor("contact"),
    },
  };
}

async function readMediaBlock(
  base: string,
  model: string,
  userText: string,
  mediaBlock: Record<string, unknown>,
): Promise<{ extracted: ExtractedDoc; model: string }> {
  let response: Response;
  try {
    response = await fetchApi(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildChatBody({ model, userText, mediaBlock })),
    });
  } catch (error) {
    throw new LocalUnreachableError(base, error instanceof Error ? error.message : "no response");
  }
  if (!response.ok) throw await responseError(response);

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error(`${model} returned an empty response.`);
  return { extracted: normalise(parseJsonLoose(content)), model: payload.model || model };
}

/** Read one document with the model running on this machine. */
export async function readWithLocalModel(
  provider: Pick<LocalProviderInfo, "baseUrl" | "models" | "supportsPdf">,
  job: LocalJob,
): Promise<{ extracted: ExtractedDoc; model: string }> {
  const base = trimBase(provider.baseUrl);
  const mediaBlocks = await mediaBlocksFor(job);
  const userText = userTextFor(job.chatContext);
  const order = provider.models.filter(Boolean);
  if (order.length === 0) throw new Error("No model id is configured for this local endpoint.");

  let lastError: Error | null = null;

  for (let index = 0; index < order.length; index += 1) {
    const model = order[index];
    if (!model) continue;
    const isLast = index === order.length - 1;
    try {
      // Sending all rendered PDF pages as base64 in one POST exceeds the
      // hosted preview's request ceiling. Read pages sequentially, then merge
      // their structured output into one attachment result.
      const pageResults: ExtractedDoc[] = new Array(mediaBlocks.length);
      let usedModel = model;
      let next = 0;
      const worker = async () => {
        while (true) {
          const current = next;
          next += 1;
          const mediaBlock = mediaBlocks[current];
          if (!mediaBlock) return;
          const result = await readMediaBlock(base, model, userText, mediaBlock);
          pageResults[current] = result.extracted;
          usedModel = result.model;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PAGE_CONCURRENCY, mediaBlocks.length) }, () => worker()),
      );
      const firstPage = pageResults[0];
      if (!firstPage) throw new Error("The document had no readable image pages.");
      return {
        extracted: pageResults.length === 1 ? firstPage : mergePageExtractions(pageResults),
        model: usedModel,
      };
    } catch (error) {
      if (error instanceof LocalUnreachableError) throw error;
      lastError = new Error(
        `Local model failed on ${model}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      if (!isLast) continue;
      throw lastError;
    }
  }

  throw lastError ?? new Error("The document could not be read on this computer.");
}
