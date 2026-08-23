// Decide, without running a model, what is worth sending to the model.
//
// On a CPU-only host a document costs 30 to 200 seconds, and a year of WhatsApp
// traffic is mostly stickers, voice notes and photos of people. Removing those
// is free time back.
//
// THE ASYMMETRY THAT SHAPES EVERYTHING HERE: a wrong "skip" silently drops a
// real receipt from the final spreadsheet and nobody notices until
// reconciliation. A wrong "read" costs a couple of minutes on a machine that is
// running unattended for days anyway. So skipping has to earn its place, and
// almost nothing does.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// A content filter was built here and then removed. It skipped an image when
// the surrounding messages were purely social (greetings, prayers, thanks) and
// mentioned no money or supplies. Measured against realistic message contexts,
// it discarded 8 of 11 genuine receipts: in this group people send paperwork
// with "good morning sir, here" and nothing else, which is textually identical
// to a greeting photo. The discriminating information is inside the image, so
// no amount of regex tuning fixes it. See `mentionsProcurement` below for what
// that signal is good for instead.
//
// Nothing here is destructive: a skipped attachment keeps its row and its file,
// and the existing requeue path (scope "skipped") restores every one.

export type TriageInput = {
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

export type TriageVerdict = {
  decision: "read" | "skip";
  /** Which rule decided, for auditing a dry run. */
  rule: string;
  /** Stored on the attachment so a human can see why it was set aside. */
  reason: string;
};

const read = (rule: string, reason: string): TriageVerdict => ({ decision: "read", rule, reason });
const skip = (rule: string, reason: string): TriageVerdict => ({ decision: "skip", rule, reason });

// WhatsApp exports name files by kind: IMG-, STK- (sticker), PTT- (push to
// talk voice note), VID-, AUD-, DOC-.
const STICKER_NAME = /(^|[/\\])STK-/i;
const VOICE_NAME = /(^|[/\\])PTT-/i;
const VIDEO_NAME = /(^|[/\\])VID-/i;
const AUDIO_NAME = /(^|[/\\])AUD-/i;

/** A sticker that slipped past the naming check is still tiny and webp. */
const STICKER_MAX_BYTES = 60 * 1024;

/**
 * Judge an attachment from its metadata alone.
 *
 * Every rule that skips answers "this cannot contain a readable page", never
 * "this is probably not interesting". That is the whole design.
 */
export function triageAttachment(input: TriageInput): TriageVerdict {
  const mime = (input.mimeType ?? "").toLowerCase();
  const name = input.filename;

  if (mime.startsWith("audio/") || VOICE_NAME.test(name) || AUDIO_NAME.test(name)) {
    return skip("audio", "Voice note or audio file: there is no page to read.");
  }
  if (mime.startsWith("video/") || VIDEO_NAME.test(name)) {
    return skip("video", "Video file: the reader only handles images and PDFs.");
  }
  if (STICKER_NAME.test(name)) {
    return skip("sticker", "WhatsApp sticker.");
  }
  // Stickers are webp and small. A large webp is more likely a screenshot of a
  // bank transfer, which is exactly the payment proof we want, so size is
  // required as well as format.
  if (
    mime === "image/webp" &&
    input.sizeBytes !== null &&
    input.sizeBytes > 0 &&
    input.sizeBytes <= STICKER_MAX_BYTES
  ) {
    return skip(
      "sticker",
      `Small webp (${Math.round(input.sizeBytes / 1024)} KB): almost certainly a sticker.`,
    );
  }
  return read("readable", "Could contain a readable page.");
}

/**
 * Money, or the vocabulary of buying things.
 *
 * This is NOT used to skip anything, because its absence means nothing: a
 * receipt is often sent with no message at all. It is used to ORDER the queue,
 * so attachments whose conversation talks about payments get read first. On a
 * run measured in days that matters: stop it early, or have it interrupted, and
 * the documents you actually wanted are already done.
 *
 * Ordering is risk-free in a way that filtering is not. Everything still gets
 * read eventually; only the sequence changes.
 */
const PROCUREMENT_SIGNAL =
  /(₦|ngn|naira|kobo|\bn[\s.]?\d[\d,]{2,}|\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b|\b\d+\.\d{2}\b|paid|payment|pay\b|receipt|invoice|requisition|request|supply|supplied|supplies|deliver|delivery|delivered|balance|transfer|teller|\bpos\b|amount|total|cost|price|bill|order|purchase|procure|stock|drugs?|syringe|glove|tablet|carton|sachet|vial|consumable)/i;

/** True when the surrounding conversation hints at paperwork. Ordering only. */
export function mentionsProcurement(chatContext: string): boolean {
  return PROCUREMENT_SIGNAL.test(chatContext);
}

export type TriageSummary = {
  total: number;
  read: number;
  skipped: number;
  /** How many each rule accounted for, most common first. */
  byRule: { rule: string; count: number; decision: TriageVerdict["decision"] }[];
};

export function summariseTriage(verdicts: TriageVerdict[]): TriageSummary {
  const counts = new Map<string, { count: number; decision: TriageVerdict["decision"] }>();
  for (const verdict of verdicts) {
    const existing = counts.get(verdict.rule);
    if (existing) existing.count += 1;
    else counts.set(verdict.rule, { count: 1, decision: verdict.decision });
  }
  return {
    total: verdicts.length,
    read: verdicts.filter((v) => v.decision === "read").length,
    skipped: verdicts.filter((v) => v.decision === "skip").length,
    byRule: [...counts.entries()]
      .map(([rule, { count, decision }]) => ({ rule, count, decision }))
      .sort((a, b) => b.count - a.count),
  };
}
