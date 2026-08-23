#!/usr/bin/env node
//
// Measure whether a local model is fast and accurate enough to read your
// archive, before committing hours of compute to a full run.
//
// It deliberately imports the app's real SYSTEM_PROMPT and normalise() from
// src/lib/doc-extract.ts rather than restating them, so a number produced here
// means the same thing as a number produced by the app. If the prompt changes,
// this benchmark changes with it.
//
//   node scripts/benchmark-local-model.mjs \
//     --base-url http://localhost:11434/v1 \
//     --model qwen3-vl:2b \
//     --images ./sample-receipts
//
//   # compare candidates on the same documents
//   --model qwen3-vl:2b,qwen3-vl:4b,minicpm-v4.6:1b
//
// Requires Node 23.6+ (native TypeScript type stripping).

import { readdir, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SYSTEM_PROMPT, normalise, parseJsonLoose, userTextFor } from "../src/lib/doc-extract.ts";

const run = promisify(execFile);

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    model: { type: "string" },
    images: { type: "string" },
    limit: { type: "string", default: "10" },
    // Total corpus size, used only to extrapolate the finish time.
    total: { type: "string", default: "3936" },
    // The app downscales to 1600px before sending (src/lib/local-read.ts).
    // Matching that here is what makes the timings representative.
    resize: { type: "boolean", default: true },
    "no-resize": { type: "boolean", default: false },
    json: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values["base-url"] || !values.model || !values.images) {
  console.log(`
Measure a local model against your own documents.

Required
  --base-url <url>    e.g. http://localhost:11434/v1 or https://x.ngrok-free.app/v1
  --model <ids>       one id, or several comma-separated
  --images <dir>      folder of representative receipts/invoices

Optional
  --limit <n>         images to test per model (default 10)
  --total <n>         corpus size for the extrapolation (default 3936)
  --no-resize         send originals instead of matching the app's 1600px downscale
  --json <file>       also write the raw results
`);
  process.exit(values.help ? 0 : 2);
}

const baseUrl = values["base-url"].replace(/\/+$/, "");
const models = values.model.split(",").map((m) => m.trim()).filter(Boolean);
const limit = Number(values.limit);
const total = Number(values.total);
const shouldResize = values["no-resize"] ? false : values.resize;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const percentile = (xs, p) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const duration = (seconds) => {
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86400).toFixed(1)} days`;
};

/**
 * Match the browser's downscale so timings reflect real payloads. `sips` ships
 * with macOS, so this needs no extra dependency; without it we send originals
 * and say so, rather than silently benchmarking something else.
 */
async function prepareImages(files) {
  if (!shouldResize) return files.map((path) => ({ path, resized: false }));
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "wa-bench-"));
    await run("sips", ["--version"]);
  } catch {
    console.log("!  sips unavailable, so originals are sent and these timings run pessimistic.\n");
    return files.map((path) => ({ path, resized: false }));
  }
  const out = [];
  for (const path of files) {
    const target = join(dir, `${basename(path, extname(path))}.jpg`);
    try {
      await run("sips", ["-Z", "1600", "-s", "format", "jpeg", path, "--out", target]);
      out.push({ path: target, resized: true, original: path });
    } catch {
      out.push({ path, resized: false });
    }
  }
  return out;
}

async function readOne(model, image) {
  const bytes = await readFile(image.path);
  const mime = MIME[extname(image.path).toLowerCase()] ?? "image/jpeg";
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userTextFor("") },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    // Must stream, for two reasons. Node's fetch aborts after 300s waiting for
    // response headers, and a non-streaming request sends none until generation
    // finishes: on a CPU-only host that reliably trips at exactly 5 minutes and
    // surfaces as a bare "fetch failed". The app streams for the same reason,
    // so this also keeps the benchmark representative of a real run.
    stream: true,
  };

  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const elapsed = (performance.now() - started) / 1000;
      // ngrok answers with a full HTML error page. Dumping that at the user
      // hides the one thing they need to know, which is that the tunnel died.
      const ngrokError = res.headers.get("ngrok-error-code");
      if (ngrokError === "ERR_NGROK_3200") {
        return {
          ok: false,
          elapsed,
          fatal: true,
          error: "the ngrok tunnel is offline. Restart it and keep its terminal window open.",
        };
      }
      if (ngrokError) return { ok: false, elapsed, fatal: true, error: `tunnel error ${ngrokError}.` };
      return { ok: false, elapsed, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }

    // Reasoning models stream their thoughts into a separate field. Track it, so
    // "produced 4,000 characters of reasoning and no answer" is reported as
    // exactly that rather than as an empty response.
    let content = "";
    let reasoning = "";
    let firstContentAt = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const json = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!json || json === "[DONE]") continue;
        try {
          const chunk = JSON.parse(json);
          const delta = chunk?.choices?.[0]?.delta ?? {};
          const piece = delta.content ?? chunk?.message?.content ?? "";
          if (piece) {
            if (firstContentAt === null) firstContentAt = performance.now();
            content += piece;
          }
          if (delta.reasoning) reasoning += delta.reasoning;
        } catch {
          // Keepalive or partial frame; malformed model output is handled below.
        }
      }
    }

    const elapsed = (performance.now() - started) / 1000;
    if (!content && reasoning) {
      return {
        ok: false,
        elapsed,
        error:
          `reasoned for ${reasoning.length} characters and returned no answer. ` +
          `Use a non-reasoning build of this model (an "-instruct" tag).`,
      };
    }
    try {
      return {
        ok: true,
        elapsed,
        extracted: normalise(parseJsonLoose(content)),
        kb: Math.round(bytes.length / 1024),
        firstTokenSeconds: firstContentAt === null ? null : (firstContentAt - started) / 1000,
      };
    } catch (error) {
      // Reached the model and got a reply, but not usable JSON. This is the
      // failure mode small models actually exhibit, so it is counted, not hidden.
      return { ok: false, elapsed, error: `unparseable output: ${error.message}`, raw: content.slice(0, 200) };
    }
  } catch (error) {
    return { ok: false, elapsed: (performance.now() - started) / 1000, error: error.message };
  }
}

function summarise(model, results) {
  const good = results.filter((r) => r.ok);
  const times = good.map((r) => r.elapsed);
  const filled = (key) => good.filter((r) => r.extracted[key] !== null).length;
  const withItems = good.filter((r) => r.extracted.items.length > 0).length;

  return {
    model,
    attempted: results.length,
    succeeded: good.length,
    successRate: results.length ? good.length / results.length : 0,
    medianSeconds: median(times),
    meanSeconds: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    p90Seconds: percentile(times, 90),
    projectedSeconds: median(times) * total,
    fields: {
      facility_name: filled("facility_name"),
      total_amount: filled("total_amount"),
      document_date: filled("document_date"),
      items: withItems,
    },
    errors: results.filter((r) => !r.ok).map((r) => r.error),
  };
}

function report(summary) {
  const pct = (n) => `${Math.round((n / Math.max(1, summary.succeeded)) * 100)}%`;
  console.log(`\n\x1b[1m${summary.model}\x1b[0m`);
  console.log(`  read ${summary.succeeded}/${summary.attempted} documents  (${Math.round(summary.successRate * 100)}% returned usable JSON)`);
  if (summary.succeeded === 0) {
    console.log("  \x1b[31mno successful reads, see errors below\x1b[0m");
  } else {
    console.log(`  median ${summary.medianSeconds.toFixed(1)}s   mean ${summary.meanSeconds.toFixed(1)}s   p90 ${summary.p90Seconds.toFixed(1)}s  per document`);
    console.log(`  \x1b[1m${duration(summary.projectedSeconds)}\x1b[0m to read ${total.toLocaleString()} documents at the median`);
    console.log("  fields found (of successful reads):");
    console.log(`    facility ${pct(summary.fields.facility_name)}   amount ${pct(summary.fields.total_amount)}   date ${pct(summary.fields.document_date)}   line items ${pct(summary.fields.items)}`);
  }
  const shown = summary.errors.slice(0, 3);
  for (const error of shown) console.log(`  \x1b[31m·\x1b[0m ${error}`);
  if (summary.errors.length > shown.length) {
    console.log(`  \x1b[31m·\x1b[0m ${summary.errors.length - shown.length} more error(s)`);
  }
}

// ------------------------------------------------------------------- main --

const entries = await readdir(values.images, { withFileTypes: true }).catch(() => {
  console.error(`Could not read the images folder: ${values.images}`);
  process.exit(1);
});
const files = entries
  .filter((entry) => entry.isFile() && IMAGE_EXT.has(extname(entry.name).toLowerCase()))
  .map((entry) => join(values.images, entry.name))
  .sort()
  .slice(0, limit);

if (files.length === 0) {
  console.error(`No images found in ${values.images} (looked for ${[...IMAGE_EXT].join(", ")}).`);
  process.exit(1);
}

console.log(`\nBenchmarking ${models.length} model(s) on ${files.length} document(s)`);
console.log(`Endpoint: ${baseUrl}`);
const prepared = await prepareImages(files);
if (prepared.some((p) => p.resized)) {
  console.log("Images downscaled to 1600px to match what the app sends.");
}

const summaries = [];
let fatal = null;
for (const model of models) {
  if (fatal) break;
  process.stdout.write(`\n${model}: `);
  const results = [];
  for (const image of prepared) {
    const result = await readOne(model, image);
    results.push(result);
    process.stdout.write(result.ok ? "\x1b[32m.\x1b[0m" : "\x1b[31mx\x1b[0m");
    // No sense grinding through 30 documents against a dead tunnel.
    if (result.fatal) {
      fatal = result.error;
      break;
    }
  }
  console.log("");
  summaries.push(summarise(model, results));
}

if (fatal) {
  console.log(`\n\x1b[31mStopped early: ${fatal}\x1b[0m`);
}

console.log("\n" + "─".repeat(64));
for (const summary of summaries) report(summary);

if (summaries.length > 1) {
  const usable = summaries.filter((s) => s.succeeded > 0);
  if (usable.length > 0) {
    const fastest = usable.reduce((a, b) => (a.medianSeconds <= b.medianSeconds ? a : b));
    console.log(`\n\x1b[1mFastest with usable output:\x1b[0m ${fastest.model} (${fastest.medianSeconds.toFixed(1)}s/doc)`);
    console.log("Pick on accuracy first: the fastest model is worthless if the fields are wrong.");
  }
}

console.log(
  "\nThese are real measurements on real documents. Trust them over any estimate,\n" +
  "including the ones in docs/LOCAL_MODEL.md.\n",
);

if (values.json) {
  await writeFile(values.json, JSON.stringify(summaries, null, 2));
  console.log(`Wrote ${values.json}\n`);
}
