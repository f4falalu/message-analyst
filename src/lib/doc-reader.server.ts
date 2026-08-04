// Server-only helpers for reading request/receipt documents with Lovable AI.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-3.6-flash";

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
  apiKey: string;
  mimeType: string;
  filename: string;
  signedUrl: string;
  chatContext: string;
}): Promise<ExtractedDoc> {
  const isPdf = params.mimeType === "application/pdf";

  let mediaBlock: Record<string, unknown>;
  if (isPdf) {
    const fileRes = await fetch(params.signedUrl);
    if (!fileRes.ok) throw new Error(`Could not download attachment (${fileRes.status})`);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    // A PDF has to be inlined as base64, which costs roughly 2.4x its size in
    // memory. Anything very large is skipped rather than crashing the batch.
    const MAX_PDF_BYTES = 6 * 1024 * 1024;
    if (bytes.length > MAX_PDF_BYTES) {
      throw new Error(
        `PDF is too large to read automatically (${(bytes.length / 1024 / 1024).toFixed(1)} MB, limit 6 MB).`,
      );
    }
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    }
    const base64 = btoa(parts.join(""));
    parts.length = 0;
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

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": params.apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [{ type: "text", text: userText }, mediaBlock] },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`AI request failed [${response.status}]: ${body}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("AI returned an empty response");

  return normalise(parseJsonLoose(content));
}
