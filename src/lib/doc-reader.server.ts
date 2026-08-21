// Server-only helpers for reading request/receipt documents with a cloud model.

import {
  isModelCooling,
  markModelCooling,
  providerHeaders,
  type ProviderConfig,
} from "./ai-provider.server";
import {
  buildChatBody,
  bytesToBase64,
  normalise,
  parseJsonLoose,
  userTextFor,
  type ExtractedDoc,
  type FieldConfidence,
} from "./doc-extract";

export type { ExtractedDoc, FieldConfidence };

/** How large an inlined PDF may be. Heavy files are read one at a time. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Thrown when a document cannot be read *yet* (too large for the current
 * ceiling). Callers must park it as "deferred" — never as read-and-empty,
 * otherwise matching would claim the document said nothing.
 */
export class DeferError extends Error {
  readonly deferred = true;
  constructor(message: string) {
    super(message);
    this.name = "DeferError";
  }
}

export class AiRequestError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;
  readonly retryAfterMs: number;
  readonly model: string;

  constructor(params: {
    message: string;
    status: number;
    rateLimited: boolean;
    retryAfterMs: number;
    model: string;
  }) {
    super(params.message);
    this.name = "AiRequestError";
    this.status = params.status;
    this.rateLimited = params.rateLimited;
    this.retryAfterMs = params.retryAfterMs;
    this.model = params.model;
  }
}

export async function readDocument(params: {
  provider: ProviderConfig;
  mimeType: string;
  filename: string;
  signedUrl: string;
  chatContext: string;
}): Promise<ExtractedDoc> {
  const isPdf = params.mimeType === "application/pdf";
  if (isPdf && !params.provider.supportsPdf) {
    throw new DeferError(
      `"${params.provider.label}" is set up for images only, so this PDF has not been read yet. Switch to a PDF-capable model and queue it again.`,
    );
  }

  let mediaBlock: Record<string, unknown>;
  if (isPdf) {
    const fileRes = await fetch(params.signedUrl);
    if (!fileRes.ok) throw new Error(`Could not download attachment (${fileRes.status})`);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    // A PDF has to be inlined as base64, which costs roughly 1.4x its size.
    // Big files run alone on the heavy lane, so the ceiling can be generous.
    if (bytes.length > MAX_PDF_BYTES) {
      throw new DeferError(
        `PDF is larger than the current reading limit (${(bytes.length / 1024 / 1024).toFixed(1)} MB, limit ${(
          MAX_PDF_BYTES /
          1024 /
          1024
        ).toFixed(0)} MB). Held back for a bigger pass — it has not been read yet.`,
      );
    }
    mediaBlock = {
      type: "file",
      file: {
        filename: params.filename,
        file_data: `data:application/pdf;base64,${bytesToBase64(bytes)}`,
      },
    };
  } else {
    mediaBlock = { type: "image_url", image_url: { url: params.signedUrl } };
  }

  const userText = userTextFor(params.chatContext);

  // Bounce across the configured model list: a rate limited or unavailable
  // model steps aside and the next one reads this file straight away.
  const configured = params.provider.models.length
    ? params.provider.models
    : [params.provider.model];
  const warm = configured.filter((m) => !isModelCooling(m));
  const order = warm.length ? [...warm, ...configured.filter((m) => !warm.includes(m))] : configured;
  const isOpenRouter = params.provider.baseUrl.includes("openrouter.ai");

  let lastError: Error | null = null;

  for (let index = 0; index < order.length; index += 1) {
    const model = order[index]!;
    const isLast = index === order.length - 1;

    const body = buildChatBody({ model, userText, mediaBlock });
    // OpenRouter can also route around a dead upstream on its own side, but
    // its API accepts at most three entries. The outer loop still preserves
    // the complete configured fallback chain beyond this native window.
    if (isOpenRouter && order.length > 1) body["models"] = order.slice(index, index + 3);

    let response: Response;
    try {
      response = await fetch(`${params.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(params.provider),
        body: JSON.stringify(body),
      });
    } catch (networkError) {
      lastError = networkError as Error;
      if (isLast) throw lastError;
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      // OpenRouter sometimes wraps a rate limit from its PDF parsing service in
      // HTTP 400. Classify the response body as well as the HTTP status so the
      // file rotates/requeues instead of being recorded as permanently broken.
      const bodySaysRateLimited =
        /rate[ -]?limit|too many requests|retry shortly|temporarily throttled|capacity limit/i.test(text);
      const rateLimited = response.status === 429 || bodySaysRateLimited;
      const retryAfterSeconds = Number(response.headers.get("Retry-After"));
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 30_000;
      const error = new AiRequestError({
        message: `AI request failed [${response.status}] on ${model}: ${text}`,
        status: response.status,
        rateLimited,
        retryAfterMs,
        model,
      });
      lastError = error;

      const modelUnavailable =
        response.status === 404 ||
        (response.status === 400 && /model.{0,80}(not found|unavailable|no endpoint|not supported)/i.test(text));
      const switchable = rateLimited || modelUnavailable || response.status >= 500;
      if (rateLimited) markModelCooling(model, retryAfterMs);
      if (switchable && !isLast) continue;
      throw error;
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    if (!content) {
      lastError = new Error(`AI returned an empty response from ${model}`);
      if (!isLast) continue;
      throw lastError;
    }

    return { ...normalise(parseJsonLoose(content)), usedModel: payload.model || model };
  }

  throw lastError ?? new Error("The document could not be read.");
}
