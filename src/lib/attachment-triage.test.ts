import { describe, expect, it } from "vitest";
import {
  mentionsProcurement,
  summariseTriage,
  triageAttachment,
  type TriageInput,
} from "./attachment-triage";

const attachment = (over: Partial<TriageInput> = {}): TriageInput => ({
  filename: "IMG-20260814-WA0012.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 240_000,
  ...over,
});

// A wrong skip silently loses a receipt from the spreadsheet. A wrong read
// costs a couple of minutes on a machine that runs unattended for days. These
// tests exist mainly to pin down that asymmetry.
describe("triageAttachment", () => {
  describe("skips only what cannot contain a readable page", () => {
    const cases: [string, Partial<TriageInput>][] = [
      ["a voice note by mime", { mimeType: "audio/ogg" }],
      ["a voice note by filename", { filename: "PTT-20260814-WA0001.opus", mimeType: null }],
      ["an audio file by filename", { filename: "AUD-20260814-WA0002.m4a", mimeType: null }],
      ["a video by mime", { mimeType: "video/mp4" }],
      ["a video by filename", { filename: "VID-20260814-WA0005.mp4", mimeType: null }],
      ["a sticker by filename", { filename: "STK-20260814-WA0003.webp", mimeType: "image/webp" }],
      [
        "a small webp with no telltale name",
        { filename: "x.webp", mimeType: "image/webp", sizeBytes: 18_000 },
      ],
    ];
    for (const [label, over] of cases) {
      it(`skips ${label}`, () => {
        expect(triageAttachment(attachment(over)).decision).toBe("skip");
      });
    }
  });

  describe("reads everything else", () => {
    // A large webp is more likely a screenshot of a bank transfer than a
    // sticker, and those are exactly the payment proofs we want.
    it("reads a large webp, which is probably a screenshot", () => {
      expect(
        triageAttachment(attachment({ mimeType: "image/webp", sizeBytes: 400_000 })).decision,
      ).toBe("read");
    });

    it("does not treat an unknown size as a sticker", () => {
      expect(
        triageAttachment(attachment({ mimeType: "image/webp", sizeBytes: null })).decision,
      ).toBe("read");
    });

    it("reads PDFs, which the browser lane rasterises", () => {
      expect(
        triageAttachment(attachment({ filename: "DOC-2026.pdf", mimeType: "application/pdf" }))
          .decision,
      ).toBe("read");
    });

    it("reads an ordinary photo", () => {
      expect(triageAttachment(attachment()).decision).toBe("read");
    });

    it("reads a file with no mime type rather than guessing", () => {
      expect(triageAttachment(attachment({ mimeType: null })).decision).toBe("read");
    });

    it("reads a tiny jpeg, since only webp implies a sticker", () => {
      expect(triageAttachment(attachment({ sizeBytes: 9_000 })).decision).toBe("read");
    });
  });

  it("always explains itself, so a dry run can be audited", () => {
    const verdict = triageAttachment(attachment());
    expect(verdict.rule).not.toBe("");
    expect(verdict.reason.length).toBeGreaterThan(10);
  });
});

// Regression guard on a deliberate design decision. A content filter used to
// live here and skipped images whose surrounding chat was purely social. It
// discarded 8 of 11 genuine receipts, because paperwork in this group arrives
// with "good morning sir, here" and nothing else. If anyone reintroduces
// content-based skipping, these fail first.
describe("content never causes a skip", () => {
  const unhelpfulButReal = [
    "good morning sir, here",
    "Musa: good morning\nAisha: here it is",
    "assalamu alaikum, see this",
    "thank you sir",
    "good afternoon, attached",
    "barka da yamma",
    "well done, sent",
    "",
    "here",
    "sir",
  ];
  for (const context of unhelpfulButReal) {
    it(`a real receipt sent with ${JSON.stringify(context)} is still read`, () => {
      // The signature takes no chat context at all, which is the guarantee.
      expect(triageAttachment(attachment()).decision).toBe("read");
    });
  }
});

// Used to ORDER the queue, never to exclude. So a false positive is free and a
// false negative only delays a document.
describe("mentionsProcurement", () => {
  describe("recognises money as people actually write it", () => {
    const money = [
      "paid 20,000 naira today",
      "₦52,800 transferred",
      "N 12,500.00 balance remaining",
      // The bare thousands-separated number that an earlier version missed.
      "Aisha: good morning\nMusa: 25,000",
      "total is 45000",
      "sent 1,250.50",
    ];
    for (const text of money) {
      it(JSON.stringify(text), () => expect(mentionsProcurement(text)).toBe(true));
    }
  });

  describe("recognises the vocabulary of supplies", () => {
    const supplies = [
      "here is the receipt",
      "invoice attached",
      "the requisition for this month",
      "we have supplied the gloves",
      "delivery done, see teller",
      "POS printout attached",
      "2 cartons of syringes",
      "drugs for the clinic",
    ];
    for (const text of supplies) {
      it(JSON.stringify(text), () => expect(mentionsProcurement(text)).toBe(true));
    }
  });

  it("stays quiet on purely social conversation", () => {
    expect(mentionsProcurement("good morning everyone")).toBe(false);
    expect(mentionsProcurement("barka da safe")).toBe(false);
    expect(mentionsProcurement("")).toBe(false);
  });
});

describe("summariseTriage", () => {
  it("counts decisions and groups by rule, commonest first", () => {
    const verdicts = [
      triageAttachment(attachment({ mimeType: "audio/ogg" })),
      triageAttachment(attachment({ mimeType: "audio/ogg" })),
      triageAttachment(attachment({ mimeType: "video/mp4" })),
      triageAttachment(attachment()),
    ];
    const summary = summariseTriage(verdicts);
    expect(summary.total).toBe(4);
    expect(summary.skipped).toBe(3);
    expect(summary.read).toBe(1);
    expect(summary.byRule[0]).toEqual({ rule: "audio", count: 2, decision: "skip" });
  });

  it("handles an empty run", () => {
    expect(summariseTriage([])).toEqual({ total: 0, read: 0, skipped: 0, byRule: [] });
  });
});
