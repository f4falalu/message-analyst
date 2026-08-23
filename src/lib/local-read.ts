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
import { SUGGESTED_LOCAL_MODEL } from "./ai-models";
import type { LocalJob, LocalProviderInfo } from "./local-read.functions";

/** The endpoint could not be reached at all — the file stays "waiting". */
export class LocalUnreachableError extends Error {
  readonly unreachable = true;
  constructor(baseUrl: string, detail: string) {
    super(`Could not reach the model on this computer (${baseUrl}): ${detail}`);
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

/**
 * The local lane exists for hardware chosen for privacy or cost rather than
 * speed, where generation is measured at 1.7-3.0 tok/s and dominates the cost
 * per document. So it asks for the compact schema by default. Set
 * `wa-archive:full-local-reads` to "true" in localStorage to get the full
 * schema back, at roughly twice the time per document.
 *
 * The cloud lane (doc-reader.server.ts) is untouched: there, output length is
 * cheap and the extra fields are worth having.
 */
const FULL_LOCAL_READS_KEY = "wa-archive:full-local-reads";

/**
 * A ceiling, not a target. The compact schema needs roughly 250 tokens; this
 * leaves room for a long itemised document while still stopping a model that
 * has started rambling. Ollama maps max_tokens to num_predict.
 */
const LOCAL_MAX_TOKENS = 700;

export function localReadsAreCompact(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(FULL_LOCAL_READS_KEY) !== "true";
  } catch {
    // Private browsing and blocked storage both throw. Default to fast.
    return true;
  }
}

const MAX_LOCAL_BYTES = 60 * 1024 * 1024;
// The hosting ingress sits in front of the relay route and rejects oversized
// JSON before route code runs. This leaves room for prompt/context JSON too.
const MAX_LOCAL_IMAGE_DATA_URL_CHARS = 560_000;
// Ollama normally serialises inference. Multiple simultaneous vision requests
// increase memory pressure and can make the tunnel look unresponsive, so keep
// one document page in flight while still processing the whole document.
const PAGE_CONCURRENCY = 1;

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
    const isGenerationRequest = /\/chat\/completions\/?$/i.test(parsed.pathname);
    // Prefer the browser-to-ngrok path. Vision inference can take longer than
    // the hosted relay request lifetime, which otherwise produces an HTML 502
    // even though Ollama is still working. A correctly configured Ollama/ngrok
    // endpoint permits this request through CORS.
    let directError: string | null = null;
    try {
      // No custom headers here. Ollama's CORS preflight only allows a fixed
      // header list, and "ngrok-skip-browser-warning" is not on it — sending it
      // makes the browser fail the preflight ("Failed to fetch"). The warning
      // page only appears for HTML GETs, so an API call does not need it.
      const direct = await fetch(url, init);
      if (!isInterstitial(direct) && direct.status !== 403) return direct;
      directError = direct.status === 403 ? "Ollama refused this page's origin (403)" : "the tunnel returned its browser warning page";
      // A 403 from Ollama means it refused this page's origin. The hosted relay
      // carries no browser origin, so it is the only remaining path.
    } catch (error) {
      if (error instanceof LocalUnreachableError) throw error;
      directError = error instanceof Error ? error.message : "no response";
      // Browser-side block (CORS/mixed content). Fall through to the relay.
    }

    // Generation never goes through the relay. Vision inference on a CPU runs
    // for minutes, far beyond the hosted request lifetime, so the relay always
    // ends in an HTML 502 that surfaces as a blank error screen. Report the
    // actionable CORS fix instead.
    if (isGenerationRequest) {
      throw new LocalUnreachableError(
        parsed.origin,
        `${directError}. Set OLLAMA_ORIGINS=* as a system environment variable on the computer running Ollama, fully quit and reopen Ollama, then restart the ngrok tunnel`,
      );
    }

    // Short metadata calls (models, tags, show, pull) are safe to relay.
    try {
      return await fetch(
        `/api/public/local-model-relay?target=${encodeURIComponent(url)}`,
        init,
      );
    } catch (error) {
      if (error instanceof LocalUnreachableError) throw error;
      throw new LocalUnreachableError(
        parsed.origin,
        `${directError}. Set OLLAMA_ORIGINS=* as a system environment variable on the computer running Ollama, fully quit and reopen Ollama, then restart the ngrok tunnel`,
      );
    }

  }
  const res = await fetch(url, init);
  if (!isInterstitial(res)) return res;
  const retry = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      "ngrok-skip-browser-warning": "true",
    },
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
 *
 * This is the *fallback* signal only. Ollama can answer the question directly
 * (see `fetchVisionCapability`) and an authoritative answer always wins. Names
 * are guesswork, so keep this list conservative: wrongly calling a text-only
 * model "vision" costs a multi-hour run that produces nothing, which is a worse
 * outcome than being told to double-check the model.
 *
 * Bare `ocr` covers the document-specialist family (glm-ocr, deepseek-ocr,
 * got-ocr, nanonets-ocr, olmocr …), which the previous `got-ocr`-only pattern
 * rejected outright.
 */
const VISION_HINTS =
  /(vl|vision|ocr|llava|bakllava|moondream|minicpm-v|internvl|pixtral|gemma3|gemma4|medgemma|granite3\.?2-vision|qwen2\.?5vl|qwen3-vl|llama3\.2-vision|gpt-4o|gemini|claude|florence|docling|nanonets)/i;

export function isVisionModel(id: string): boolean {
  return VISION_HINTS.test(id);
}

/**
 * Ask the endpoint what a model can actually do rather than guessing from its
 * name. Ollama's `/api/show` reports `capabilities: ["completion", "vision"]`.
 *
 * Returns null when the endpoint does not implement it (LM Studio, vLLM and
 * llama.cpp serve the OpenAI surface only), so the caller knows to fall back to
 * the name heuristic instead of treating "no answer" as "not vision".
 */
export async function fetchModelCapabilities(
  baseUrl: string,
  model: string,
): Promise<string[] | null> {
  const root = trimBase(baseUrl).replace(/\/v1$/, "");
  try {
    const res = await fetchApi(`${root}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { capabilities?: unknown };
    if (!Array.isArray(payload.capabilities)) return null;
    return payload.capabilities
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.toLowerCase());
  } catch {
    return null;
  }
}

/** True/false from the endpoint, or null when it did not answer. */
export async function fetchVisionCapability(
  baseUrl: string,
  model: string,
): Promise<boolean | null> {
  const capabilities = await fetchModelCapabilities(baseUrl, model);
  return capabilities === null ? null : capabilities.includes("vision");
}

export type VisionResolution = {
  visionModels: string[];
  /**
   * Vision models that also reason before answering. Measured on a CPU-only
   * host, qwen3-vl:2b spent 5,581 characters on reasoning and emitted zero
   * content, so every document failed with "returned an empty response" after
   * roughly six minutes of work. Ollama's OpenAI-compatible endpoint ignores
   * both `think: false` and `chat_template_kwargs`, so the only real fix is a
   * non-reasoning build (an `-instruct` tag). Worth warning about loudly.
   */
  thinkingModels: string[];
  /** True when at least one verdict came from the endpoint, not from a name. */
  authoritative: boolean;
};

/**
 * Split a model list into those that can read a picture, preferring the
 * endpoint's own answer and falling back to the name heuristic per model.
 * `/api/show` is metadata only (no inference), so asking in parallel is cheap
 * even over a tunnel.
 */
export async function resolveVisionModels(
  baseUrl: string,
  models: string[],
): Promise<VisionResolution> {
  const verdicts = await Promise.all(
    models.map(async (model) => ({
      model,
      capabilities: await fetchModelCapabilities(baseUrl, model),
    })),
  );
  const isVision = ({ model, capabilities }: (typeof verdicts)[number]) =>
    capabilities === null ? isVisionModel(model) : capabilities.includes("vision");

  return {
    visionModels: verdicts.filter(isVision).map(({ model }) => model),
    thinkingModels: verdicts
      .filter((entry) => isVision(entry) && (entry.capabilities?.includes("thinking") ?? false))
      .map(({ model }) => model),
    authoritative: verdicts.some(({ capabilities }) => capabilities !== null),
  };
}

export type EndpointCheck = {
  ok: boolean;
  models: string[];
  visionModels: string[];
  /** Vision models that reason first. See VisionResolution.thinkingModels. */
  thinkingModels: string[];
  detail: string;
  /** Non-fatal problems worth showing before someone starts a long run. */
  warnings: string[];
};

/**
 * Verify a local endpoint before a run: is it reachable, and does it serve at
 * least one model that can read a picture?
 */
export async function checkLocalEndpoint(baseUrl: string): Promise<EndpointCheck> {
  try {
    const base = trimBase(baseUrl);
    const modelsResponse = await fetchApi(`${base}/models`);
    if (!modelsResponse.ok) {
      throw new LocalUnreachableError(
        base,
        modelsResponse.status === 403
          ? "Ollama rejected this app's origin (403). Start Ollama with OLLAMA_ORIGINS=* and restart the ngrok tunnel"
          : `the endpoint returned ${modelsResponse.status}`,
      );
    }
    const payload = (await modelsResponse.json()) as { data?: { id?: string }[] };
    const models = Array.from(
      new Set(
        (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id)),
      ),
    );
    if (models.length === 0) {
      return {
        ok: false,
        models,
        visionModels: [],
        thinkingModels: [],
        warnings: [],
        detail: "Reachable, but it listed no models. Pull or load a vision model first.",
      };
    }

    const { visionModels, thinkingModels, authoritative } = await resolveVisionModels(base, models);
    if (visionModels.length === 0) {
      return {
        ok: false,
        models,
        visionModels,
        thinkingModels,
        warnings: [],
        detail:
          `Reachable with ${models.length} model${models.length === 1 ? "" : "s"}, but none of them can read pictures. ` +
          `Pull a vision model before starting a run. On a CPU-only machine start with ${SUGGESTED_LOCAL_MODEL}.`,
      };
    }

    // A reasoning model streams its thoughts into a separate field and can
    // finish without ever emitting `content`, which this app reads. That looks
    // like "the model returned an empty response" after minutes of work, per
    // document, with no clue as to why. Say so before the run, not after.
    const warnings = thinkingModels.map(
      (model) =>
        `"${model}" reasons before answering. It can spend its whole budget on reasoning and return no answer at all, ` +
        `which this app sees as an empty response. Ollama's OpenAI-compatible endpoint ignores requests to turn that off, ` +
        `so prefer a non-reasoning build such as "${model.replace(/:(.+)$/, ":$1-instruct")}".`,
    );

    return {
      ok: true,
      models,
      visionModels,
      thinkingModels,
      warnings,
      detail:
        `Reachable: ${visionModels.length} vision-capable model${visionModels.length === 1 ? "" : "s"} of ${models.length} available ` +
        `(${visionModels.slice(0, 3).join(", ")})` +
        (authoritative
          ? "."
          : ", identified by name because this endpoint does not report capabilities."),
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      visionModels: [],
      thinkingModels: [],
      warnings: [],
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
      // A malformed PDF can keep pdf.js busy indefinitely and stall the lane.
      pages = await Promise.race([
        pdfToImageDataUrls(bytes),
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error("rendering took longer than 90s")), 90_000),
        ),
      ]);

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
    // 900px, measured. Qwen3-VL's dynamic resolution floors at ~1,351 prompt
    // tokens below this, so shrinking further costs detail and buys nothing,
    // while 1600px costs 2,087 tokens and ~50 extra seconds per document on a
    // CPU-only host. Prefill, not generation, is the dominant cost there.
    let scale = Math.min(1, 900 / longest);
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

/** One page must come back within this window or the lane is freed. */
const PAGE_DEADLINE_MS = 420_000;

async function readMediaBlock(
  base: string,
  model: string,
  userText: string,
  mediaBlock: Record<string, unknown>,
): Promise<{ extracted: ExtractedDoc; model: string }> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_DEADLINE_MS);
  try {
    const body = buildChatBody({
      model,
      userText,
      mediaBlock,
      compact: localReadsAreCompact(),
      maxTokens: LOCAL_MAX_TOKENS,
    });
    response = await fetchApi(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      // Ollama emits incremental chunks as it generates. Streaming lets the
      // relay return response headers/data before the hosting request deadline
      // instead of waiting silently for the complete vision result.
      body: JSON.stringify({ ...body, stream: true }),
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof LocalUnreachableError) throw error;
    if (controller.signal.aborted) {
      throw new LocalDeferError(
        `This computer did not finish the page within ${Math.round(PAGE_DEADLINE_MS / 1000)}s. Held back — it has not been read yet.`,
      );
    }
    throw new LocalUnreachableError(base, error instanceof Error ? error.message : "no response");
  }
  clearTimeout(timer);
  if (!response.ok) throw await responseError(response);


  const raw = await response.text();
  let content = "";
  let responseModel = model;
  const chunks = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const json = chunk.startsWith("data:") ? chunk.slice(5).trim() : chunk;
    if (!json || json === "[DONE]") continue;
    try {
      const payload = JSON.parse(json) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        message?: { content?: string };
        model?: string;
      };
      responseModel = payload.model || responseModel;
      content +=
        payload.choices?.[0]?.delta?.content ??
        payload.choices?.[0]?.message?.content ??
        payload.message?.content ??
        "";
    } catch {
      // Ignore transport keepalive lines; malformed model output is handled by
      // parseJsonLoose after all valid chunks have been assembled.
    }
  }
  if (!content) throw new Error(`${model} returned an empty response.`);
  return { extracted: normalise(parseJsonLoose(content)), model: responseModel };
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
