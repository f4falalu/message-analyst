// Pure, shared rules: name normalisation via a configurable mapping layer and
// field-level validation that turns messy extractions into readable flags.

export type Mapping = {
  kind: "facility" | "item";
  pattern: string;
  canonical: string;
};

export type Issue = {
  field: "facility" | "items" | "quantity" | "amount" | "payment_date" | "request_date" | "contact" | "confidence";
  level: "error" | "warning";
  message: string;
};

export type ValidatableRecord = {
  facility_name: string | null;
  items: { name: string; quantity: number | null; unit: string | null; amount: number | null }[];
  amount_paid: number | null;
  currency: string | null;
  request_date: string | null;
  payment_date: string | null;
  status: string;
  confidence: number | null;
};

const PLACEHOLDERS = new Set([
  "",
  "n/a",
  "na",
  "none",
  "unknown",
  "not stated",
  "not specified",
  "nil",
  "-",
  "--",
  "?",
  "test",
  "xxx",
]);

/** Loose key used for matching a written name against a mapping pattern. */
export function matchKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleish(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Applies the mapping layer. A pattern matches when the loose keys are equal,
 * or when the pattern key appears as a whole phrase inside the value key —
 * so "kaloko hc" and "Kaloko Health Centre" both fold into one canonical name.
 */
export function applyMapping(
  value: string | null | undefined,
  kind: Mapping["kind"],
  mappings: Mapping[],
): string | null {
  const raw = typeof value === "string" ? titleish(value) : "";
  if (!raw) return null;
  const key = matchKey(raw);
  if (!key) return null;

  const relevant = mappings.filter((mapping) => mapping.kind === kind);

  for (const mapping of relevant) {
    if (matchKey(mapping.pattern) === key) return titleish(mapping.canonical);
  }
  // Longest pattern wins so "malaria rdt kit" beats "rdt".
  const contained = relevant
    .map((mapping) => ({ mapping, patternKey: matchKey(mapping.pattern) }))
    .filter(({ patternKey }) => patternKey.length >= 3 && ` ${key} `.includes(` ${patternKey} `))
    .sort((a, b) => b.patternKey.length - a.patternKey.length)[0];

  return contained ? titleish(contained.mapping.canonical) : raw;
}

export function normaliseRecordNames<T extends ValidatableRecord>(record: T, mappings: Mapping[]): T {
  return {
    ...record,
    facility_name: applyMapping(record.facility_name, "facility", mappings),
    items: record.items.map((item) => ({
      ...item,
      name: applyMapping(item.name, "item", mappings) ?? item.name,
    })),
  };
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Field-level checks, expressed the way a person reviewing the ledger would say them. */
export function validateRecord(record: ValidatableRecord, today = new Date()): Issue[] {
  const issues: Issue[] = [];
  const add = (field: Issue["field"], level: Issue["level"], message: string) =>
    issues.push({ field, level, message });

  // Facility name
  const facility = (record.facility_name ?? "").trim();
  if (!facility) {
    add("facility", "error", "Facility name is missing");
  } else if (PLACEHOLDERS.has(facility.toLowerCase())) {
    add("facility", "error", `Facility name is a placeholder ("${facility}")`);
  } else {
    if (facility.replace(/[^a-zA-Z]/g, "").length < 3) {
      add("facility", "error", `Facility name looks unreadable ("${facility}")`);
    }
    if (facility.length > 80) add("facility", "warning", "Facility name is unusually long — may include stray text");
    if (/\d{4,}/.test(facility)) add("facility", "warning", "Facility name contains a long number — check the scan");
  }

  // Items
  if (record.items.length === 0) {
    add("items", "error", "No items were read from the document");
  } else {
    const seen = new Map<string, number>();
    for (const item of record.items) {
      const name = (item.name ?? "").trim();
      if (!name || PLACEHOLDERS.has(name.toLowerCase())) {
        add("items", "error", "An item row has no readable name");
      } else if (name.replace(/[^a-zA-Z]/g, "").length < 2) {
        add("items", "warning", `Item name looks unreadable ("${name}")`);
      }
      const key = matchKey(name);
      if (key) seen.set(key, (seen.get(key) ?? 0) + 1);

      if (item.quantity !== null) {
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
          add("quantity", "error", `Quantity for "${name || "an item"}" is not a positive number`);
        } else if (!Number.isInteger(item.quantity) && item.quantity < 1) {
          add("quantity", "warning", `Quantity for "${name}" is a fraction — check the unit`);
        } else if (item.quantity > 100000) {
          add("quantity", "warning", `Quantity for "${name}" (${item.quantity}) looks too large`);
        }
      }
    }
    const missingQty = record.items.filter((item) => item.quantity === null).length;
    if (missingQty === record.items.length) {
      add("quantity", "warning", "No quantities were read for any item");
    } else if (missingQty > 0) {
      add("quantity", "warning", `${missingQty} of ${record.items.length} items have no quantity`);
    }
    for (const [key, count] of seen) {
      if (count > 1) add("items", "warning", `"${key}" appears ${count} times — possible duplicate line`);
    }
  }

  // Amount
  if (record.amount_paid !== null) {
    if (!Number.isFinite(record.amount_paid) || record.amount_paid < 0) {
      add("amount", "error", "Amount is not a valid positive number");
    } else if (record.amount_paid === 0) {
      add("amount", "warning", "Amount reads as zero");
    }
    if (!record.currency) add("amount", "warning", "Amount has no currency on the document");
  } else if (record.status === "paid") {
    add("amount", "error", "Marked paid but no amount was found");
  }

  // Dates
  const todayTime = today.getTime();
  const requestTime = parseDate(record.request_date);
  const paymentTime = parseDate(record.payment_date);

  if (record.request_date && requestTime === null) add("request_date", "error", "Request date is not a real date");
  if (!record.request_date) add("request_date", "warning", "No request date on the document or nearby message");

  if (record.payment_date) {
    if (paymentTime === null) {
      add("payment_date", "error", "Payment date is not a real date");
    } else {
      if (paymentTime > todayTime + 86_400_000) add("payment_date", "error", "Payment date is in the future");
      if (paymentTime < Date.parse("2015-01-01")) add("payment_date", "warning", "Payment date is implausibly old");
      if (requestTime !== null && paymentTime < requestTime) {
        add("payment_date", "error", "Payment date is before the request date");
      }
      if (requestTime !== null && paymentTime - requestTime > 365 * 86_400_000) {
        add("payment_date", "warning", "Payment is more than a year after the request");
      }
    }
  } else if (record.status === "paid") {
    add("payment_date", "error", "Marked paid but no payment date was found");
  }

  if (record.confidence !== null && record.confidence < 0.6) {
    add("confidence", "warning", `The reader was only ${Math.round(record.confidence * 100)}% sure of this document`);
  }

  return issues;
}

export function issuesToText(issues: Issue[]): string {
  return issues.map((issue) => `${issue.level === "error" ? "!" : "?"} ${issue.message}`).join("\n");
}
