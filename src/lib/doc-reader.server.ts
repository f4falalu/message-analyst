// Server-only helpers for reading request/receipt documents with Lovable AI.

import {
  isModelCooling,
  markModelCooling,
  providerHeaders,
  type ProviderConfig,
} from "./ai-provider.server";

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


export type FieldConfidence = {
  facility_name: number | null;
  items: number | null;
  total_amount: number | null;
  document_date: number | null;
  payment_date: number | null;
  contact: number | null;
};

export type ExtractedDoc = {
  doc_type: "request" | "receipt" | "invoice" | "other";
  facility_name: string | null;
  items: { name: string; quantity: number | null; unit: string | null; amount: number | null }[];
  total_amount: number | null;
  currency: string | null;
  document_date: string | null;
  payment_date: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  reference: string | null;
  raw_text: string;
  confidence: number;
  field_confidence: FieldConfidence;
  /** Which model id actually produced this read. */
  usedModel?: string;
};

const SYSTEM_PROMPT = `You read scanned procurement paperwork exchanged over WhatsApp: supply requests, requisitions, invoices, receipts, payment confirmations and hand-written notes from health facilities.

Transcribe what is actually on the page. Never invent a facility, item, amount or date. Use null when a field is not present or not legible.

Return ONLY a JSON object with exactly these keys:
{
  "doc_type": "request" | "receipt" | "invoice" | "other",
  "facility_name": string | null,
  "items": [{ "name": string, "quantity": number | null, "unit": string | null, "amount": number | null }],
  "total_amount": number | null,
  "currency": string | null,
  "document_date": "YYYY-MM-DD" | null,
  "payment_date": "YYYY-MM-DD" | null,
  "contact_name": string | null,
  "contact_phone": string | null,
  "reference": string | null,
  "raw_text": string,
  "confidence": number,
  "field_confidence": {
    "facility_name": number | null,
    "items": number | null,
    "total_amount": number | null,
    "document_date": number | null,
    "payment_date": number | null,
    "contact": number | null
  }
}

doc_type: "request" for requisitions/order lists, "invoice" for priced bills, "receipt" for proof of payment, "other" for anything else (photos of people, screenshots, unrelated pages).
total_amount: numeric only, no currency symbols or thousands separators.
raw_text: a plain-text transcription of the document (keep it under 4000 characters).
confidence: 0 to 1, how sure you are the structured fields are correct.
field_confidence: 0 to 1 per field, how legible/certain that specific field was. Use null for fields that are absent from the document.`;

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    const n = Number(cleaned);
    if (cleaned !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

function coerceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

function normalise(input: unknown): ExtractedDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  const typeValue = String(raw["doc_type"] ?? "other").toLowerCase();
  const docType: ExtractedDoc["doc_type"] =
    typeValue === "request" || typeValue === "receipt" || typeValue === "invoice" ? typeValue : "other";

  const itemsInput = Array.isArray(raw["items"]) ? (raw["items"] as unknown[]) : [];
  const items = itemsInput
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const name = typeof item["name"] === "string" ? item["name"].trim() : "";
      if (!name) return null;
      return {
        name,
        quantity: coerceNumber(item["quantity"]),
        unit: typeof item["unit"] === "string" ? item["unit"] : null,
        amount: coerceNumber(item["amount"]),
      };
    })
    .filter((item): item is ExtractedDoc["items"][number] => item !== null);

  const str = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  const confidence = coerceNumber(raw["confidence"]);

  const fcRaw = (raw["field_confidence"] ?? {}) as Record<string, unknown>;
  const clamp = (value: unknown): number | null => {
    const n = coerceNumber(value);
    return n === null ? null : Math.max(0, Math.min(1, n));
  };

  return {
    doc_type: docType,
    facility_name: str("facility_name"),
    items,
    total_amount: coerceNumber(raw["total_amount"]),
    currency: str("currency"),
    document_date: coerceDate(raw["document_date"]),
    payment_date: coerceDate(raw["payment_date"]),
    contact_name: str("contact_name"),
    contact_phone: str("contact_phone"),
    reference: str("reference"),
    raw_text: typeof raw["raw_text"] === "string" ? raw["raw_text"].slice(0, 8000) : "",
    confidence: confidence === null ? 0.5 : Math.max(0, Math.min(1, confidence)),
    field_confidence: {
      facility_name: clamp(fcRaw["facility_name"]),
      items: clamp(fcRaw["items"]),
      total_amount: clamp(fcRaw["total_amount"]),
      document_date: clamp(fcRaw["document_date"]),
      payment_date: clamp(fcRaw["payment_date"]),
      contact: clamp(fcRaw["contact"]),
    },
  };
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return JSON");
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
    // Encode incrementally so the file is never held twice in memory.
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const base64 = btoa(binary);
    binary = "";
    mediaBlock = {
      type: "file",
      file: { filename: params.filename, file_data: `data:application/pdf;base64,${base64}` },
    };
  } else {
    mediaBlock = { type: "image_url", image_url: { url: params.signedUrl } };
  }


  const userText = params.chatContext
    ? `Surrounding WhatsApp conversation (context only — the document itself is authoritative):\n${params.chatContext}\n\nRead the attached document.`
    : "Read the attached document.";

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

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [{ type: "text", text: userText }, mediaBlock] },
      ],
      response_format: { type: "json_object" },
    };
    // OpenRouter can also route around a dead upstream on its own side.
    if (isOpenRouter && order.length > 1) body["models"] = order.slice(index);

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
