import { describe, expect, it } from "vitest";
import {
  buildChatBody,
  COMPACT_SYSTEM_PROMPT,
  normalise,
  parseJsonLoose,
  SYSTEM_PROMPT,
} from "./doc-extract";

// Everything here handles output from a model that was *asked* for strict JSON
// but is under no obligation to produce it. Small local models drift from the
// schema far more than hosted ones, so these paths carry the real risk.
describe("parseJsonLoose", () => {
  it("parses a clean object", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips a ```json fence", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips a bare ``` fence", () => {
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("digs the object out of surrounding prose", () => {
    expect(parseJsonLoose('Here is the result:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it("tolerates leading and trailing whitespace", () => {
    expect(parseJsonLoose('  \n {"a":1} \n ')).toEqual({ a: 1 });
  });

  it("keeps the outermost object when prose contains braces after it", () => {
    expect(parseJsonLoose('{"a":{"b":2}} trailing note')).toEqual({ a: { b: 2 } });
  });

  it("rejects output with no object at all", () => {
    expect(() => parseJsonLoose("I could not read this document.")).toThrow(
      "Model did not return JSON",
    );
  });

  it("rejects an empty response", () => {
    expect(() => parseJsonLoose("")).toThrow("Model did not return JSON");
  });

  it("rejects malformed braces rather than returning junk", () => {
    expect(() => parseJsonLoose("prose { not: valid, json } more")).toThrow();
  });
});

describe("normalise", () => {
  it("fills every field with a safe default when given nothing", () => {
    const result = normalise(null);
    expect(result.doc_type).toBe("other");
    expect(result.facility_name).toBeNull();
    expect(result.items).toEqual([]);
    expect(result.total_amount).toBeNull();
    expect(result.raw_text).toBe("");
    // 0.5 not 0: an absent confidence is unknown, not "certainly wrong".
    expect(result.confidence).toBe(0.5);
  });

  describe("amounts", () => {
    it("keeps a plain number", () => {
      expect(normalise({ total_amount: 12500 }).total_amount).toBe(12500);
    });

    it("recovers a number from a currency string with separators", () => {
      expect(normalise({ total_amount: "₦12,500.50" }).total_amount).toBe(12500.5);
    });

    it("recovers a negative number", () => {
      expect(normalise({ total_amount: "-250" }).total_amount).toBe(-250);
    });

    it("returns null for text that holds no number", () => {
      expect(normalise({ total_amount: "not stated" }).total_amount).toBeNull();
    });

    it("returns null rather than NaN for an empty string", () => {
      expect(normalise({ total_amount: "" }).total_amount).toBeNull();
    });
  });

  describe("items", () => {
    it("keeps well-formed rows and coerces their numbers", () => {
      const result = normalise({
        items: [{ name: "Gloves", quantity: "20", unit: "box", amount: "1,500" }],
      });
      expect(result.items).toEqual([{ name: "Gloves", quantity: 20, unit: "box", amount: 1500 }]);
    });

    it("drops rows with no name, which are hallucinated filler", () => {
      const result = normalise({
        items: [{ name: "", quantity: 1 }, { quantity: 2 }, { name: "Syringes", quantity: 5 }],
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.name).toBe("Syringes");
    });

    it("trims whitespace from names", () => {
      expect(normalise({ items: [{ name: "  Gauze  " }] }).items[0]?.name).toBe("Gauze");
    });

    it("survives items being the wrong type entirely", () => {
      expect(normalise({ items: "Gloves, Syringes" }).items).toEqual([]);
      expect(normalise({ items: [null, 42, "x"] }).items).toEqual([]);
    });
  });

  describe("doc_type", () => {
    it("accepts the four known values", () => {
      for (const type of ["request", "receipt", "invoice", "other"]) {
        expect(normalise({ doc_type: type }).doc_type).toBe(type);
      }
    });

    it("normalises case", () => {
      expect(normalise({ doc_type: "RECEIPT" }).doc_type).toBe("receipt");
    });

    it("falls back to other for anything unrecognised", () => {
      expect(normalise({ doc_type: "purchase_order" }).doc_type).toBe("other");
    });
  });

  describe("dates", () => {
    it("accepts an ISO date", () => {
      expect(normalise({ document_date: "2026-08-23" }).document_date).toBe("2026-08-23");
    });

    it("truncates a full timestamp to the date", () => {
      expect(normalise({ document_date: "2026-08-23T14:26:18Z" }).document_date).toBe("2026-08-23");
    });

    // Documented limitation, not an endorsement. The prompt asks for YYYY-MM-DD,
    // and anything else is discarded silently rather than mis-parsed. Worth
    // revisiting if real extractions come back with local date formats.
    it("discards non-ISO formats instead of guessing day/month order", () => {
      expect(normalise({ document_date: "23/08/2026" }).document_date).toBeNull();
      expect(normalise({ document_date: "Aug 23, 2026" }).document_date).toBeNull();
    });
  });

  describe("confidence", () => {
    it("clamps above one", () => {
      expect(normalise({ confidence: 5 }).confidence).toBe(1);
    });

    it("clamps below zero", () => {
      expect(normalise({ confidence: -2 }).confidence).toBe(0);
    });

    it("clamps per-field confidence too", () => {
      const result = normalise({ field_confidence: { facility_name: 3, items: -1 } });
      expect(result.field_confidence.facility_name).toBe(1);
      expect(result.field_confidence.items).toBe(0);
    });

    it("leaves absent per-field confidence as null", () => {
      expect(normalise({}).field_confidence.total_amount).toBeNull();
    });
  });

  it("caps raw_text so one document cannot bloat a row", () => {
    const result = normalise({ raw_text: "x".repeat(20_000) });
    expect(result.raw_text).toHaveLength(8000);
  });

  it("treats a whitespace-only string as absent", () => {
    expect(normalise({ facility_name: "   " }).facility_name).toBeNull();
  });
});

describe("buildChatBody", () => {
  it("puts the shared system prompt first", () => {
    const body = buildChatBody({ model: "qwen3-vl:2b", userText: "Read it." });
    const messages = body["messages"] as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });

  it("asks for a JSON object so compliant runtimes constrain their output", () => {
    const body = buildChatBody({ model: "qwen3-vl:2b", userText: "Read it." });
    expect(body["response_format"]).toEqual({ type: "json_object" });
  });

  it("carries a single media block after the text", () => {
    const media = { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } };
    const body = buildChatBody({ model: "m", userText: "Read it.", mediaBlock: media });
    const messages = body["messages"] as { role: string; content: unknown[] }[];
    expect(messages[1]?.content).toEqual([{ type: "text", text: "Read it." }, media]);
  });

  it("carries several media blocks, one per rendered PDF page", () => {
    const pages = [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
    ];
    const body = buildChatBody({ model: "m", userText: "Read it.", mediaBlocks: pages });
    const messages = body["messages"] as { role: string; content: unknown[] }[];
    expect(messages[1]?.content).toHaveLength(3);
  });

  it("sends a text-only request when there is no media", () => {
    const body = buildChatBody({ model: "m", userText: "Read it." });
    const messages = body["messages"] as { role: string; content: unknown[] }[];
    expect(messages[1]?.content).toEqual([{ type: "text", text: "Read it." }]);
  });

  it("omits max_tokens unless asked, so hosted providers keep their defaults", () => {
    expect(buildChatBody({ model: "m", userText: "x" })).not.toHaveProperty("max_tokens");
    expect(buildChatBody({ model: "m", userText: "x", maxTokens: 700 })["max_tokens"]).toBe(700);
  });
});

// Generation is 97% of the time per document on a CPU-only host, so output
// length is the cost. These assertions guard the properties that make the
// compact schema cheaper, not its exact wording.
describe("COMPACT_SYSTEM_PROMPT", () => {
  it("is selected by the compact flag", () => {
    const body = buildChatBody({ model: "m", userText: "x", compact: true });
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toBe(COMPACT_SYSTEM_PROMPT);
  });

  it("defaults to the full schema when the flag is absent", () => {
    const body = buildChatBody({ model: "m", userText: "x" });
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
  });

  it("drops the two most expensive fields", () => {
    expect(COMPACT_SYSTEM_PROMPT).not.toContain("raw_text");
    expect(COMPACT_SYSTEM_PROMPT).not.toContain("field_confidence");
    expect(SYSTEM_PROMPT).toContain("raw_text");
  });

  it("still asks for every field the spreadsheet is built from", () => {
    for (const key of [
      "doc_type",
      "facility_name",
      "items",
      "total_amount",
      "currency",
      "document_date",
      "payment_date",
      "contact_name",
      "contact_phone",
      "reference",
      "confidence",
    ]) {
      expect(COMPACT_SYSTEM_PROMPT).toContain(key);
    }
  });

  it("asks for single-line output, since pretty-printing costs real tokens", () => {
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/single line/i);
  });

  it("is materially shorter than the full prompt", () => {
    expect(COMPACT_SYSTEM_PROMPT.length).toBeLessThan(SYSTEM_PROMPT.length);
  });

  it("still normalises into the same shape, with the dropped fields defaulted", () => {
    // What a compact reply looks like: no raw_text, no field_confidence.
    const reply = {
      doc_type: "receipt",
      facility_name: "Kofar Mata PHC",
      items: [{ name: "Gloves", quantity: 20, unit: "box", amount: 30000 }],
      total_amount: 52800,
      currency: "NGN",
      document_date: "2026-08-14",
      payment_date: "2026-08-21",
      contact_name: "Aisha Bello",
      contact_phone: "0803 555 0142",
      reference: "REQ-2026-0142",
      confidence: 0.9,
    };
    const result = normalise(reply);
    expect(result.total_amount).toBe(52800);
    expect(result.items).toHaveLength(1);
    expect(result.document_date).toBe("2026-08-14");
    // Absent fields degrade to safe defaults rather than breaking the row.
    expect(result.raw_text).toBe("");
    expect(result.field_confidence.total_amount).toBeNull();
  });
});
