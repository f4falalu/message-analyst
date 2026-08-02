// Pure WhatsApp export parser (browser-safe, no I/O).

export type ParsedMessage = {
  seq: number;
  sent_at: string | null;
  sender: string | null;
  body: string;
  attachment_filename: string | null;
};

export type ParsedChat = {
  messages: ParsedMessage[];
  contacts: { display_name: string; phone: string | null; message_count: number }[];
  dayFirst: boolean;
};

const INVISIBLE = /[\u200e\u200f\u202a-\u202e\ufeff]/g;

// iOS: [27/07/2026, 15:07:32] Sender: body
const IOS_HEAD = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?\]\s*([^:]{1,120}?):\s?([\s\S]*)$/;
// Android: 27/07/2026, 15:07 - Sender: body
const ANDROID_HEAD = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?\s+-\s+([^:]{1,120}?):\s?([\s\S]*)$/;
// System lines without a sender
const IOS_SYS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+\d{1,2}:\d{2}/;
const ANDROID_SYS = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+\d{1,2}:\d{2}\s+-\s/;

const ATTACH_IOS = /<attached:\s*([^>]+)>/i;
const ATTACH_ANDROID = /^(.+?\.[A-Za-z0-9]{2,5})\s*\((?:file|document|archivo) attached\)/i;
const PHONE_RE = /^\+?[\d\s\-()]{7,}$/;

function isHeader(line: string): boolean {
  return IOS_SYS.test(line) || ANDROID_SYS.test(line);
}

function matchHeader(line: string): RegExpMatchArray | null {
  return line.match(IOS_HEAD) ?? line.match(ANDROID_HEAD);
}

function toIso(
  a: number,
  b: number,
  yRaw: number,
  hh: number,
  mm: number,
  ss: number,
  ampm: string | undefined,
  dayFirst: boolean,
): string | null {
  const day = dayFirst ? a : b;
  const month = dayFirst ? b : a;
  const year = yRaw < 100 ? 2000 + yRaw : yRaw;
  let hour = hh;
  if (ampm) {
    const pm = ampm.toLowerCase() === "pm";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, mm, ss));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Detects whether dates are day-first (27/07) or month-first (07/27). */
function detectDayFirst(lines: string[]): boolean {
  let firstOver12 = 0;
  let secondOver12 = 0;
  for (const line of lines) {
    const m = matchHeader(line);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) firstOver12++;
    if (b > 12) secondOver12++;
    if (firstOver12 + secondOver12 > 200) break;
  }
  if (firstOver12 > secondOver12) return true;
  if (secondOver12 > firstOver12) return false;
  return true; // WhatsApp default in most locales
}

export function parseChat(text: string): ParsedChat {
  const clean = text.replace(INVISIBLE, "");
  const lines = clean.split(/\r?\n/);
  const dayFirst = detectDayFirst(lines);

  const messages: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;
  let seq = 0;

  const push = () => {
    if (!current) return;
    const body = current.body.trim();
    const attachIos = body.match(ATTACH_IOS);
    const attachAndroid = body.match(ATTACH_ANDROID);
    current.attachment_filename = attachIos?.[1]
      ? attachIos[1].trim()
      : attachAndroid?.[1]
        ? attachAndroid[1].trim()
        : null;

    current.body = body;
    messages.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      if (current) current.body += "\n";
      continue;
    }
    const m = matchHeader(line);
    if (m) {
      push();
      seq += 1;
      current = {
        seq,
        sent_at: toIso(
          Number(m[1]),
          Number(m[2]),
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6] ?? 0),
          m[7],
          dayFirst,
        ),
        sender: m[8].trim(),
        body: m[9] ?? "",
        attachment_filename: null,
      };
    } else if (isHeader(line)) {
      // system message (encryption notice, joins/leaves) — keep as sender-less entry
      push();
      seq += 1;
      current = {
        seq,
        sent_at: null,
        sender: null,
        body: line,
        attachment_filename: null,
      };
    } else if (current) {
      current.body += "\n" + line;
    }
  }
  push();

  const byName = new Map<string, { display_name: string; phone: string | null; message_count: number }>();
  for (const msg of messages) {
    if (!msg.sender) continue;
    const existing = byName.get(msg.sender);
    if (existing) existing.message_count += 1;
    else
      byName.set(msg.sender, {
        display_name: msg.sender,
        phone: PHONE_RE.test(msg.sender) ? msg.sender.replace(/\s+/g, " ").trim() : null,
        message_count: 1,
      });
  }

  return { messages, contacts: [...byName.values()], dayFirst };
}

export function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    gif: "image/gif",
    pdf: "application/pdf",
    opus: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    txt: "text/plain",
    vcf: "text/vcard",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Only these are worth sending to the document reader. */
export function isReadable(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf";
}
