// Pure cross-referencing logic: turn parsed messages + document extractions
// into request records. No I/O so it can be unit-reasoned and reused.

import type { ExtractedDoc } from "./doc-reader.server";
import { normaliseRecordNames, validateRecord, type Issue, type Mapping } from "./data-rules";

export type BuilderMessage = {
  id: string;
  seq: number;
  sent_at: string | null;
  sender: string | null;
  body: string | null;
};

export type BuilderAttachment = {
  id: string;
  filename: string;
  message_seq: number | null;
  extracted: ExtractedDoc | null;
};

export type BuiltRecord = {
  facility_name: string | null;
  items: { name: string; quantity: number | null; unit: string | null; amount: number | null }[];
  amount_paid: number | null;
  currency: string | null;
  request_date: string | null;
  payment_date: string | null;
  requester_name: string | null;
  requester_phone: string | null;
  status: "requested" | "paid" | "unclear";
  confidence: number;
  needs_review: boolean;
  issues: Issue[];
  notes: string | null;
  sources: { kind: "message" | "attachment"; message_id?: string; attachment_id?: string }[];
};

const PHONE_IN_TEXT = /(\+?\d[\d\s\-()]{7,}\d)/;
const PAID_WORDS = /\b(paid|payment|receipt|transfer|transferred|settled|cleared|deposit)\b/i;

export function normaliseFacility(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\b(health\s*(centre|center|post|facility)|hospital|clinic|dispensary|hc|phc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toDateOnly(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Pulls a phone number out of the sender label or nearby message text. */
function findPhone(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const m = candidate.match(PHONE_IN_TEXT);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

/** A short window of conversation around an attachment, used for context + fallbacks. */
export function contextAround(
  messages: BuilderMessage[],
  bySeq: Map<number, number>,
  seq: number | null,
  radius = 4,
): BuilderMessage[] {
  if (seq === null) return [];
  const index = bySeq.get(seq);
  if (index === undefined) return [];
  return messages.slice(Math.max(0, index - radius), Math.min(messages.length, index + radius + 1));
}

export function buildRecords(
  messages: BuilderMessage[],
  attachments: BuilderAttachment[],
): BuiltRecord[] {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map<number, number>();
  ordered.forEach((message, index) => bySeq.set(message.seq, index));

  const docs = attachments
    .filter((attachment) => attachment.extracted && attachment.extracted.doc_type !== "other")
    .sort((a, b) => (a.message_seq ?? 0) - (b.message_seq ?? 0));

  const records: BuiltRecord[] = [];
  const receipts: { attachment: BuilderAttachment; doc: ExtractedDoc }[] = [];

  for (const attachment of docs) {
    const doc = attachment.extracted!;
    if (doc.doc_type === "receipt") {
      receipts.push({ attachment, doc });
      continue;
    }

    const anchor = attachment.message_seq !== null ? ordered[bySeq.get(attachment.message_seq) ?? -1] : undefined;
    const context = contextAround(ordered, bySeq, attachment.message_seq);
    const contextText = context.map((message) => message.body ?? "").join("\n");

    const requestDate = doc.document_date ?? toDateOnly(anchor?.sent_at ?? null);
    const facility = doc.facility_name;
    const amount = doc.total_amount;

    const missing: string[] = [];
    if (!facility) missing.push("facility");
    if (amount === null) missing.push("amount");
    if (doc.items.length === 0) missing.push("items");
    if (!requestDate) missing.push("request date");

    records.push({
      facility_name: facility,
      items: doc.items,
      amount_paid: null,
      currency: doc.currency,
      request_date: requestDate,
      payment_date: null,
      requester_name: doc.contact_name ?? anchor?.sender ?? null,
      requester_phone: doc.contact_phone ?? findPhone(anchor?.sender, contextText),
      status: "requested",
      confidence: doc.confidence,
      needs_review: missing.length > 0 || doc.confidence < 0.6,
      notes: missing.length ? `Missing from document: ${missing.join(", ")}.` : null,
      sources: [
        { kind: "attachment", attachment_id: attachment.id },
        ...context.filter((m) => (m.body ?? "").trim()).map((m) => ({ kind: "message" as const, message_id: m.id })),
      ],
    });
  }

  // Match receipts back onto the request they pay for.
  for (const { attachment, doc } of receipts) {
    const anchor = attachment.message_seq !== null ? ordered[bySeq.get(attachment.message_seq) ?? -1] : undefined;
    const context = contextAround(ordered, bySeq, attachment.message_seq);
    const paymentDate = doc.payment_date ?? doc.document_date ?? toDateOnly(anchor?.sent_at ?? null);
    const facilityKey = normaliseFacility(doc.facility_name);
    const amount = doc.total_amount;

    let best: BuiltRecord | null = null;
    let bestScore = -1;

    for (const record of records) {
      if (record.payment_date) continue;
      let score = 0;
      if (facilityKey && normaliseFacility(record.facility_name) === facilityKey) score += 3;
      if (amount !== null && record.items.length >= 0) {
        const recordTotal =
          record.amount_paid ??
          record.items.reduce((sum, item) => sum + (item.amount ?? 0), 0) ??
          0;
        if (recordTotal > 0 && Math.abs(recordTotal - amount) / Math.max(recordTotal, amount) < 0.02) score += 3;
      }
      if (paymentDate && record.request_date) {
        const gap = daysBetween(record.request_date, paymentDate);
        if (Date.parse(paymentDate) >= Date.parse(record.request_date) && gap <= 120) {
          score += gap <= 30 ? 2 : 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = record;
      }
    }

    if (best && bestScore >= 3) {
      best.payment_date = paymentDate;
      best.amount_paid = amount ?? best.amount_paid;
      best.currency = best.currency ?? doc.currency;
      best.status = "paid";
      best.confidence = Math.min(best.confidence, doc.confidence);
      best.sources.push({ kind: "attachment", attachment_id: attachment.id });
      if (bestScore < 5) {
        best.needs_review = true;
        best.notes = [best.notes, "Payment matched to this request with partial evidence."]
          .filter(Boolean)
          .join(" ");
      }
    } else {
      records.push({
        facility_name: doc.facility_name,
        items: doc.items,
        amount_paid: amount,
        currency: doc.currency,
        request_date: null,
        payment_date: paymentDate,
        requester_name: doc.contact_name ?? anchor?.sender ?? null,
        requester_phone: doc.contact_phone ?? findPhone(anchor?.sender, context.map((m) => m.body ?? "").join("\n")),
        status: "paid",
        confidence: doc.confidence,
        needs_review: true,
        notes: "Payment document with no matching request found in the chat.",
        sources: [
          { kind: "attachment", attachment_id: attachment.id },
          ...context.filter((m) => (m.body ?? "").trim()).map((m) => ({ kind: "message" as const, message_id: m.id })),
        ],
      });
    }
  }

  // A message that clearly confirms payment can close out a still-open request.
  for (const message of ordered) {
    const body = message.body ?? "";
    if (!PAID_WORDS.test(body)) continue;
    const date = toDateOnly(message.sent_at);
    if (!date) continue;
    const open = records.filter(
      (record) => !record.payment_date && record.request_date && Date.parse(date) >= Date.parse(record.request_date),
    );
    if (open.length !== 1) continue;
    const target = open[0]!;
    if (daysBetween(target.request_date!, date) > 60) continue;
    target.payment_date = date;
    target.status = "paid";
    target.needs_review = true;
    target.notes = [target.notes, "Payment date taken from a chat message, not a receipt."]
      .filter(Boolean)
      .join(" ");
    target.sources.push({ kind: "message", message_id: message.id });
  }

  for (const record of records) {
    if (record.amount_paid === null) {
      const sum = record.items.reduce((total, item) => total + (item.amount ?? 0), 0);
      if (sum > 0) record.amount_paid = sum;
    }
    if (!record.facility_name || record.amount_paid === null) record.needs_review = true;
    if (!record.payment_date && record.status !== "paid") record.status = "requested";
  }

  return records;
}
