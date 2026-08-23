# Running the document reader on your own machine

This app can read scanned paperwork with a model running on hardware you own,
instead of sending documents to a hosted API. This page covers how that lane
works, what hardware it needs, and how to find out whether it is fast enough for
your archive before you commit days of compute to it.

## How the local lane works

The reading happens **in the browser tab**, not on the app's server. Lovable's
servers cannot reach a machine on your desk, but your browser can.

```text
   Browser tab (running the app)
        │
        │  1. direct call, tried first        src/lib/local-read.ts
        ▼
   ngrok https tunnel
        │
        ▼
   Ollama on your machine, port 11434
```

If the direct call is refused (Ollama rejects the page's origin with a 403), the
code falls back to a small server-side relay at
`/api/public/local-model-relay`, which carries no browser origin. The relay is a
backstop, not the main path: it caps request bodies at 700 KB and aborts after
5 minutes, and slow inference can exceed both.

That split is why the connection test reports **two hops separately**. A failure
on hop 1 with hop 2 healthy means CORS. Both failing means Ollama or the tunnel
is down.

Three consequences worth knowing:

1. **The browser and the model can be on different machines.** That is the
   normal setup: open the app on your laptop, run the model on a spare desktop.
2. **The tab must stay open** for the duration of a run.
3. **Only extracted fields go back to the archive.** The document itself never
   leaves your machine on this path.

## Hardware

Speed is governed by memory bandwidth divided by model size, which makes the
download size the most honest performance number available up front.

| Host | Acceleration | Realistic |
|---|---|---|
| Apple Silicon (M1 and later) | Metal GPU | Comfortable, 7-8B models usable |
| **Intel Mac** | **None. CPU only** | 2-4B models only |
| NVIDIA GPU (Linux/Windows) | CUDA | Comfortable |

The Intel row is the one that surprises people. Per [Ollama's macOS
docs](https://github.com/ollama/ollama/blob/main/docs/macos.mdx), the system
requirement is *"Apple M series (CPU and GPU support) or x86 (CPU only)"*.
Metal acceleration is Apple Silicon only, and Ollama's other GPU backend
(Vulkan) is Windows and Linux only. An Intel Mac's integrated graphics cannot be
used for inference at all, no matter how much VRAM it reports.

## Choosing a model

All sizes below are Ollama download sizes, verified from the library.

| Model | Params | Size | Use it when |
|---|---|---|---|
| `qwen3-vl:2b` | 2B | 1.9 GB | Default. Start here on any CPU-only machine |
| `qwen3-vl:4b` | 4B | 3.3 GB | 2B misreads your documents and you can afford ~2x the time |
| `minicpm-v4.6:1b` | 0.8B | 1.6 GB | You need the absolute fastest option |
| `glm-ocr` | 0.9B | 2.2 GB | Dense tables and difficult layouts. See the caveat below |
| `qwen3-vl:8b` | 8B | 6.1 GB | You have a GPU |

**The GLM-OCR caveat.** GLM-OCR is a transcription model, not an
instruction-following extractor. It converts a page to text and markdown, and it
is very good at that: it ranks first on OmniDocBench V1.5. But it will not
reliably fill this app's JSON schema on its own, because that is not what it was
trained to do. Using it properly means a two-stage pipeline (transcribe, then
extract the fields from the text with a small text-only model), which this app
does not implement yet. Benchmark the Qwen3-VL models first and only take on
that complexity if their accuracy is genuinely insufficient.

## Setup

Run this **on the machine that will host the model**:

```sh
./scripts/setup-local-model.sh
```

It checks the macOS version and hardware, installs Ollama if needed, applies the
network and origin settings, pulls the default model, and confirms the model
actually reports a vision capability. Add `--dry-run` to see what it would do
without changing anything, or name models explicitly:

```sh
./scripts/setup-local-model.sh qwen3-vl:2b qwen3-vl:4b
```

Two settings matter, and both are applied by the script:

| Setting | Value | Why |
|---|---|---|
| `OLLAMA_HOST` | `0.0.0.0:11434` | Ollama binds loopback only by default, so the tunnel cannot reach it |
| `OLLAMA_ORIGINS` | `*` | Without this Ollama refuses the app's browser tab with a 403 |

On macOS these must be set with `launchctl setenv`, because the Ollama GUI app
does not inherit your shell environment. **They are cleared by a reboot**, so
re-run the script after restarting the machine.

Then start the tunnel and leave the window open:

```sh
ngrok http 11434 --host-header="localhost:11434"
```

Paste the `https://….ngrok-free.app/v1` URL into the app's Models page, keeping
the `/v1` suffix, and set "Runs on" to **this computer**.

A free ngrok tunnel gets a new URL every time it restarts, and the app stores
the URL, so you will need to update it in the Models page after each restart.

## Getting the most out of CPU-only hardware

Measured on a 2019 Intel MacBook Pro (i5-8279U, 16 GB) over an ngrok tunnel,
reading a printed requisition with known ground truth:

```text
qwen2.5vl:7b, full schema
  prefill    (reading the image)  1,490 tok in    7.2s  = 207 tok/s
  generation (writing the JSON)     555 tok in  335.3s  =   1.7 tok/s
                                            ─────────
                                              344.6s per document
```

**Generation is 97% of the cost.** Everything below follows from that one fact.

| Lever | Effect | Why |
|---|---|---|
| Compact schema | ~1.8x | Drops `raw_text` and `field_confidence`, ~240 of 555 tokens. On by default in the local lane |
| `-instruct` model tag | ~1.8x | 2B generates at 3.0 tok/s versus 1.7 for the 7B |
| `OLLAMA_KEEP_ALIVE=-1` | varies | Ollama evicts an idle model after 5 minutes. A document takes longer than that, so the model reloads from disk between documents |
| `max_tokens` ceiling | bounds worst case | Stops a rambling model burning minutes on one page |
| Smaller images | no speed gain | Prefill is 2% of the time. Do it to stay inside the 4096-token context, not for speed |
| **Fewer documents** | **linear** | The only lever that is not capped by hardware |

Things that do **not** help, and why:

- **A smaller model is not proportionally faster.** 2B generates only 1.8x
  faster than 7B, because both are limited by the same memory bus.
- **Concurrency does not help on one machine.** `OLLAMA_NUM_PARALLEL` defaults
  to 1, and raising it splits the same memory bandwidth while multiplying RAM.
- **Lower image resolution barely matters.** Reading the picture took 7 seconds
  out of 345.

### The realistic best case

Projected from the measured rates above, not yet measured end to end:

```text
qwen3-vl:2b-instruct, compact schema
  prefill      ~1,500 tok at ~250 tok/s  ≈    6s
  generation     ~300 tok at  3.0 tok/s  ≈  100s
                                          ───────
                                          ≈ 106s  (~1.8 min) per document
```

That is roughly 3x better than the 5.7 minutes measured with the full schema on
the 7B, and it is close to the floor for this class of hardware. **Per-document
time will not reach seconds on a CPU-only machine.** For 3,936 documents that is
about 4.8 days of continuous running; filtering the set down to the images that
are actually paperwork is what turns that into roughly a day.

## Not sending everything to the model

The only lever not capped by hardware is how many documents get read at all.
`triageImport` sets aside pending attachments that cannot contain a readable
page. It is a **dry run by default**:

```ts
// report only, changes nothing
await triageImport({ data: { importId } });

// then, once the samples look right
await triageImport({ data: { importId, apply: true } });
```

It skips audio, video and stickers. On a realistic corpus that is about **32%
of a year's attachments**, which is a third of the runtime back for no risk:
none of them contain a page to read. Skipped files keep their row and their
storage object, and the existing requeue (scope `skipped`) restores all of them.

### A content filter was built here, measured, and removed

The obvious next step is to skip images whose surrounding conversation is purely
social. It was implemented and tested against realistic message contexts, and it
**discarded 8 of 11 genuine receipts**. In this group, paperwork routinely
arrives with nothing but "good morning sir, here", which is textually identical
to a greeting photo. No amount of regex tuning fixes that, because the
information that separates the two cases is inside the image.

What survived is `mentionsProcurement()`, the same signal used for **ordering
rather than exclusion**. Reading likely-paperwork first means an interrupted or
early-stopped multi-day run has already produced the documents you wanted.
Everything is still read eventually, so being wrong costs nothing.

If you want a genuine content filter, the honest version is a cheap **visual**
triage: a small vision model answering one yes/no question at low resolution,
which is far quicker than a full extraction. That looks at the actual image, so
it can tell a receipt from a greeting. It has not been built or measured.

## Measure before you commit

Estimates are not measurements. Before starting a run over thousands of
documents, put 20 to 30 genuinely representative files in a folder and measure:

```sh
npm run benchmark -- \
  --base-url http://localhost:11434/v1 \
  --model qwen3-vl:2b,qwen3-vl:4b \
  --images ./sample-receipts
```

It reports, per model: median, mean and p90 seconds per document; the share of
documents that came back as usable JSON; how often each field was actually
found; and a projected finish time for the whole archive.

The benchmark imports the app's real prompt and normaliser from
`src/lib/doc-extract.ts`, and downscales images to 1600px exactly as the browser
does, so its numbers transfer to a real run.

**Judge accuracy before speed.** A model that reads a document in four seconds
and gets the amount wrong is worse than useless, because the errors are quiet
and you will not notice them until reconciliation.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 403 on hop 1, hop 2 healthy | Ollama refuses the page's origin | `launchctl setenv OLLAMA_ORIGINS "*"`, restart Ollama, restart the tunnel |
| Both hops unreachable | Ollama or tunnel is down | Re-run the setup script, restart ngrok |
| HTML warning page instead of the API | ngrok interstitial | Restart with `--host-header="localhost:11434"` |
| "none of them can read pictures" | No vision-capable model | `ollama pull qwen3-vl:2b` |
| Reads work, then stop after a reboot | `launchctl` settings cleared | Re-run the setup script |
| "took too long to answer (over 5 minutes)" | Relay timeout on slow inference | Use a smaller model, or fix CORS so the direct path is used |

To ask Ollama directly whether a model can see images:

```sh
curl -s http://localhost:11434/api/show -d '{"model":"qwen3-vl:2b"}' | grep -o '"vision"'
```

The app performs this same check automatically and only falls back to guessing
from the model's name when the endpoint does not answer, which is the case for
LM Studio, vLLM and llama.cpp.

## Known limitations

- **PDFs are rasterised in the browser** and capped at 20 pages, because local
  runtimes reject PDF attachments outright.
- **Images are downscaled to 1600px** and compressed to fit under 560 KB
  (`src/lib/local-read.ts`). For dense handwriting this is aggressive and may
  cost accuracy. Worth revisiting if the benchmark shows weak field recovery.
- **Dates outside `YYYY-MM-DD` are discarded**, not reparsed. A model returning
  `23/08/2026` yields a null date rather than a guess at day/month order. Safe,
  but it silently loses data. See `src/lib/doc-extract.test.ts`.
- **One page at a time.** `PAGE_CONCURRENCY` is 1 because Ollama serialises
  inference anyway, and parallel vision requests raise memory pressure.
- **No pre-filtering.** Every attachment queued for reading is sent to the
  model. In a year of WhatsApp traffic a large share of images are greetings and
  screenshots rather than paperwork, so the cheapest available speedup is not
  sending them at all. This is not implemented.
