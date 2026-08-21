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

/** Whatever this endpoint says it can serve — OpenAI shape first, Ollama second. */
export async function listLocalModels(baseUrl: string): Promise<string[]> {
  const base = trimBase(baseUrl);
  const ids: string[] = [];
  try {
    const res = await fetch(`${base}/models`);
    if (res.ok) {
      const payload = (await res.json()) as { data?: { id?: string }[] };
      for (const entry of payload.data ?? []) if (entry.id) ids.push(entry.id);
    }
  } catch {
    /* fall through to the Ollama-native listing */
  }
  if (ids.length === 0) {
    // Ollama's own listing lives outside the /v1 compatibility path.
    const root = base.replace(/\/v1$/, "");
    try {
      const res = await fetch(`${root}/api/tags`);
      if (res.ok) {
        const payload = (await res.json()) as { models?: { name?: string }[] };
        for (const entry of payload.models ?? []) if (entry.name) ids.push(entry.name);
      }
    } catch (error) {
      if (ids.length === 0) {
        throw new LocalUnreachableError(base, error instanceof Error ? error.message : "no response");
      }
    }
  }
  return Array.from(new Set(ids));
}

export async function checkLocalEndpoint(
  baseUrl: string,
): Promise<{ ok: boolean; models: string[]; detail: string }> {
  try {
    const models = await listLocalModels(baseUrl);
    return {
      ok: true,
      models,
      detail: models.length
        ? `Reachable — ${models.length} model${models.length === 1 ? "" : "s"} available.`
        : "Reachable, but it listed no models. Pull or load a vision model first.",
    };
  } catch (error) {
    return { ok: false, models: [], detail: error instanceof Error ? error.message : "No response." };
  }
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
        headers: { "Content-Type": "application/json" },
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
