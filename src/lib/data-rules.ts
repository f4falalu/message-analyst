// Pure, shared rules: name normalisation via a configurable mapping layer and
// field-level validation that turns messy extractions into readable flags.

export type Mapping = {
  kind: "facility" | "item";
  pattern: string;
  canonical: string;
};

export type Issue = {
  field:
    | "facility"
    | "items"
    | "quantity"
    | "amount"
    | "payment_date"
    | "request_date"
    | "contact"
    | "confidence"
    | "source_match";

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

// ---------------------------------------------------------------------------
// Cross-source checks: chat.txt facts vs fields read off the attachment.
// These catch a scan that was filed under the wrong conversation, a document
// signed by someone other than the sender, or a date that drifted.
// ---------------------------------------------------------------------------

export type ChatFacts = {
  /** Sender label on the message the file arrived with. */
  sender: string | null;
  /** Phone number visible in the sender label or nearby text. */
  senderPhone: string | null;
  /** Date the file was sent, YYYY-MM-DD. */
  sentDate: string | null;
  /** Body text of the messages around the attachment. */
  contextText: string;
};

export type DocFacts = {
  facility_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  document_date: string | null;
  payment_date: string | null;
};

const FACILITY_PHRASE =
  /([A-Za-z][A-Za-z'.\- ]{2,40}?\s(?:health\s*(?:centre|center|post|facility)|hospital|clinic|dispensary|hc|phc))\b/gi;

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function phonesMatch(a: string, b: string): boolean {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 7 && longer.endsWith(shorter.slice(-9));
}

function nameOverlap(a: string, b: string): boolean {
  const partsA = new Set(matchKey(a).split(" ").filter((part) => part.length > 2));
  const partsB = matchKey(b).split(" ").filter((part) => part.length > 2);
  return partsB.some((part) => partsA.has(part));
}

function dayGap(a: string, b: string): number | null {
  const first = Date.parse(a);
  const second = Date.parse(b);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return Math.round((second - first) / 86_400_000);
}

/** Facility-looking names written in the chat around the attachment. */
export function facilitiesInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FACILITY_PHRASE)) {
    const value = match[1]?.replace(/\s+/g, " ").trim();
    if (value) found.add(value);
  }
  return [...found];
}

/**
 * Compares what the chat says with what was read off the file and returns
 * plain-language flags for every disagreement.
 */
export function crossCheckSources(chat: ChatFacts, doc: DocFacts, mappings: Mapping[] = []): Issue[] {
  const issues: Issue[] = [];
  const add = (message: string, level: Issue["level"] = "warning") =>
    issues.push({ field: "source_match", level, message });

  const contextText = chat.contextText ?? "";
  const contextKey = ` ${matchKey(contextText)} `;

  // Facility ------------------------------------------------------------
  const docFacility = applyMapping(doc.facility_name, "facility", mappings);
  const chatFacilities = facilitiesInText(contextText).map(
    (name) => applyMapping(name, "facility", mappings) ?? name,
  );
  if (docFacility) {
    const docKey = matchKey(docFacility);
    const mentioned =
      contextKey.includes(` ${docKey} `) ||
      chatFacilities.some((name) => matchKey(name) === docKey || nameOverlap(name, docFacility));
    if (chatFacilities.length > 0 && !mentioned) {
      add(
        `Facility mismatch: the file says "${docFacility}" but the chat around it mentions ${chatFacilities
          .map((name) => `"${name}"`)
          .join(", ")}`,
        "error",
      );
    } else if (chatFacilities.length === 0 && !mentioned && contextKey.trim().length > 10) {
      add(`Facility "${docFacility}" is not mentioned anywhere in the surrounding chat`);
    }
  } else if (chatFacilities.length > 0) {
    add(`No facility was read from the file, but the chat mentions "${chatFacilities[0]}"`);
  }

  // Requester name ------------------------------------------------------
  if (doc.contact_name && chat.sender) {
    if (!nameOverlap(doc.contact_name, chat.sender) && matchKey(doc.contact_name) !== matchKey(chat.sender)) {
      const inChat = contextKey.includes(` ${matchKey(doc.contact_name)} `);
      add(
        `Requester mismatch: the file is from "${doc.contact_name}" but the message was sent by "${chat.sender}"${
          inChat ? " (the name does appear elsewhere in the chat)" : ""
        }`,
        inChat ? "warning" : "error",
      );
    }
  } else if (!doc.contact_name && chat.sender) {
    add(`No requester on the file — falling back to the chat sender "${chat.sender}"`);
  }

  // Phone ---------------------------------------------------------------
  const docPhone = digits(doc.contact_phone);
  const chatPhone = digits(chat.senderPhone);
  if (docPhone.length >= 7 && chatPhone.length >= 7 && !phonesMatch(docPhone, chatPhone)) {
    add(`Contact mismatch: the file lists ${doc.contact_phone} but the chat number is ${chat.senderPhone}`);
  }

  // Dates ---------------------------------------------------------------
  if (chat.sentDate) {
    const checks: { label: string; value: string | null }[] = [
      { label: "Document date", value: doc.document_date },
      { label: "Payment date", value: doc.payment_date },
    ];
    for (const { label, value } of checks) {
      if (!value) continue;
      const gap = dayGap(value, chat.sentDate);
      if (gap === null) continue;
      if (gap < -1) {
        add(`${label} on the file (${value}) is after the day it was sent in the chat (${chat.sentDate})`, "error");
      } else if (gap > 60) {
        add(`${label} on the file (${value}) is ${gap} days before it was shared in the chat (${chat.sentDate})`);
      } else if (gap > 14) {
        add(`${label} on the file (${value}) is ${gap} days older than the chat message (${chat.sentDate})`);
      }
    }
    if (!doc.document_date && !doc.payment_date) {
      add(`No date on the file — using the chat date ${chat.sentDate} instead`);
    }
  }

  return issues;
}
