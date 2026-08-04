import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Play, Pause, X, AlertTriangle, RotateCcw, ChevronDown, ListChecks } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ingestZip, type IngestProgress, type IngestFailure } from "@/lib/ingest";
import { requeueAttachments } from "@/lib/processing.functions";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type ImportRow = {
  id: string;
  filename: string;
  status: string;
  message_count: number;
  total_files: number;
  created_at: string;
  notes: string | null;
};

/** One line in the per-import processing log. */
type LogEntry = { at: number; label: string };

/** Snapshot of an upload, kept so a page refresh can show where it stopped. */
type UploadSnapshot = {
  importId: string | null;
  zipName: string;
  phase: string;
  message: string;
  current: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  updatedAt: number;
};

const FAILURE_KEY = (importId: string) => `upload-failures:${importId}`;
const LOG_KEY = (importId: string) => `upload-log:${importId}`;
const SNAPSHOT_KEY = "upload-snapshot";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / 1_048_576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  const mbps = bytesPerSecond / 1_048_576;
  if (mbps < 1) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${mbps.toFixed(mbps < 10 ? 2 : 1)} MB/s`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const PHASE_LABEL: Record<string, string> = {
  reading: "Extract — opening the zip",
  parsing: "Parse chat.txt — reading the conversation",
  indexing: "Match attachments — saving messages and contacts",
  uploading: "Upload attachments",
  paused: "Paused",
  done: "Export ready — upload finished",
};


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Request Ledger — WhatsApp supply requests, archived" },
      {
        name: "description",
        content:
          "Upload a WhatsApp chat export and get an auditable ledger of facility supply requests: items, quantities, amounts paid, request and payment dates, and contacts.",
      },
      { property: "og:title", content: "Request Ledger — WhatsApp supply requests, archived" },
      {
        property: "og:description",
        content:
          "Turn a year of WhatsApp messages and scanned receipts into a searchable, exportable procurement record.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

const STEPS = [
  { title: "Upload the export", body: "Drop in the whole WhatsApp zip — transcript and every photo or PDF." },
  { title: "Read every document", body: "Each scan is transcribed and its facility, items, amounts and dates pulled out." },
  { title: "Cross-reference", body: "Receipts are matched back to the request they pay for, using the chat around them." },
  { title: "Search and export", body: "Review the ledger, fix anything flagged, then download it as a spreadsheet." },
];

function Home() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [uploadedCounts, setUploadedCounts] = useState<Record<string, number>>({});
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [failures, setFailures] = useState<Record<string, IngestFailure[]>>({});
  const [errorsFor, setErrorsFor] = useState<string | null>(null);
  const [requeuing, setRequeuing] = useState(false);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [rate, setRate] = useState<{ bytesPerSecond: number; etaSeconds: number } | null>(null);
  const [snapshot, setSnapshot] = useState<UploadSnapshot | null>(null);
  const requeue = useServerFn(requeueAttachments);
  const pausedRef = useRef(false);
  const cancelledRef = useRef(false);
  const samplesRef = useRef<{ at: number; bytes: number }[]>([]);
  const lastPhaseRef = useRef<string | null>(null);

  // Restore the last upload snapshot so a refresh mid-upload still shows where
  // the run stopped and which import to retry.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as UploadSnapshot;
      if (parsed && parsed.phase !== "done") setSnapshot(parsed);
    } catch {
      window.localStorage.removeItem(SNAPSHOT_KEY);
    }
  }, []);


  useEffect(() => {
    supabase
      .from("imports")
      .select("id, filename, status, message_count, total_files, created_at, notes")
      .order("created_at", { ascending: false })
      .then(async ({ data, error }) => {
        if (error) {
          toast.error(error.message);
          return;
        }
        const rows = data ?? [];
        setImports(rows);
        const counts: Record<string, number> = {};
        await Promise.all(
          rows.map(async (row) => {
            const { count } = await supabase
              .from("attachments")
              .select("id", { count: "exact", head: true })
              .eq("import_id", row.id);
            counts[row.id] = count ?? 0;
          }),
        );
        setUploadedCounts(counts);
        if (typeof window !== "undefined") {
          const stored: Record<string, IngestFailure[]> = {};
          for (const row of rows) {
            const raw = window.localStorage.getItem(FAILURE_KEY(row.id));
            if (!raw) continue;
            try {
              const parsed: unknown = JSON.parse(raw);
              if (Array.isArray(parsed)) stored[row.id] = parsed as IngestFailure[];
            } catch {
              window.localStorage.removeItem(FAILURE_KEY(row.id));
            }
          }
          setFailures(stored);

          const storedLogs: Record<string, LogEntry[]> = {};
          for (const row of rows) {
            const raw = window.localStorage.getItem(LOG_KEY(row.id));
            if (!raw) continue;
            try {
              const parsed: unknown = JSON.parse(raw);
              if (Array.isArray(parsed)) storedLogs[row.id] = parsed as LogEntry[];
            } catch {
              window.localStorage.removeItem(LOG_KEY(row.id));
            }
          }
          setLogs((current) => ({ ...storedLogs, ...current }));
        }
      });
  }, [busy]);

  const rememberFailures = (importId: string, list: IngestFailure[]) => {
    setFailures((current) => ({ ...current, [importId]: list }));
    if (typeof window === "undefined") return;
    if (list.length === 0) window.localStorage.removeItem(FAILURE_KEY(importId));
    else window.localStorage.setItem(FAILURE_KEY(importId), JSON.stringify(list.slice(0, 200)));
  };

  // Every stage change is written to a small per-import log so the card can
  // show what happened and when, even after a refresh.
  const appendLog = (importId: string | null, label: string) => {
    const key = importId ?? "pending";
    const entry: LogEntry = { at: Date.now(), label };
    setLogs((current) => {
      const next = [...(current[key] ?? []), entry].slice(-100);
      if (typeof window !== "undefined") window.localStorage.setItem(LOG_KEY(key), JSON.stringify(next));
      return { ...current, [key]: next };
    });
  };

  const adoptPendingLog = (importId: string) => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(LOG_KEY("pending"));
    if (!raw) return;
    window.localStorage.removeItem(LOG_KEY("pending"));
    try {
      const pending = JSON.parse(raw) as LogEntry[];
      setLogs((current) => {
        const merged = [...pending, ...(current[importId] ?? [])].slice(-100);
        window.localStorage.setItem(LOG_KEY(importId), JSON.stringify(merged));
        const { pending: _drop, ...rest } = current;
        void _drop;
        return { ...rest, [importId]: merged };
      });
    } catch {
      /* ignore a corrupt log */
    }
  };


  const retryFailedUploads = (importId: string) => {
    setErrorsFor(null);
    setResumeId(importId);
    toast.info("Choose the same zip — only the failed files are sent again.");
    inputRef.current?.click();
  };

  const retryFailedParses = async (importId: string) => {
    setRequeuing(true);
    try {
      const result = await requeue({ data: { importId, scope: "failed" } });
      toast.success(
        result.requeued > 0
          ? `${result.requeued.toLocaleString()} failed file(s) put back in the parse queue.`
          : "No failed files left to queue.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not re-queue those files.");
    } finally {
      setRequeuing(false);
    }
  };

  // Remembers which import each zip belongs to, so dropping the same file
  // again continues that import instead of starting a fresh one.
  const zipKey = (file: File) => `zip-import:${file.name}:${file.size}`;

  const rememberedImportId = async (file: File) => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(zipKey(file));
    if (!stored) return null;
    const { data } = await supabase.from("imports").select("id").eq("id", stored).maybeSingle();
    if (!data) {
      window.localStorage.removeItem(zipKey(file));
      return null;
    }
    return data.id;
  };

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("Please choose the WhatsApp .zip export.");
      return;
    }
    setBusy(true);
    setPaused(false);
    pausedRef.current = false;
    cancelledRef.current = false;
    samplesRef.current = [];
    lastPhaseRef.current = null;
    setRate(null);
    setSnapshot(null);
    const importId = resumeId ?? (await rememberedImportId(file));
    setActiveImportId(importId);
    if (!resumeId && importId) {
      toast.info("Picking up where this zip left off — already uploaded files are kept.");
    }
    appendLog(importId, importId ? "Resumed this import from the same zip" : "Started a new import");

    // Speed is a rolling average over the last ~20s of samples, which keeps the
    // estimate steady when individual files vary a lot in size.
    const handleProgress = (value: IngestProgress) => {
      setProgress(value);

      if (value.phase !== lastPhaseRef.current) {
        lastPhaseRef.current = value.phase;
        appendLog(importId, PHASE_LABEL[value.phase] ?? value.phase);
      }

      const bytesDone = value.bytesDone ?? 0;
      const bytesTotal = value.bytesTotal ?? 0;
      if (bytesTotal > 0 && value.phase === "uploading") {
        const now = Date.now();
        const samples = samplesRef.current;
        samples.push({ at: now, bytes: bytesDone });
        while (samples.length > 2 && now - samples[0]!.at > 20_000) samples.shift();
        const first = samples[0]!;
        const elapsed = (now - first.at) / 1000;
        const moved = bytesDone - first.bytes;
        if (elapsed >= 1 && moved > 0) {
          const bytesPerSecond = moved / elapsed;
          setRate({
            bytesPerSecond,
            etaSeconds: Math.max(0, (bytesTotal - bytesDone) / bytesPerSecond),
          });
        }
      }

      if (typeof window !== "undefined") {
        const snap: UploadSnapshot = {
          importId,
          zipName: file.name,
          phase: value.phase,
          message: value.message,
          current: value.current,
          total: value.total,
          bytesDone,
          bytesTotal,
          updatedAt: Date.now(),
        };
        window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
      }
    };

    try {
      const result = await ingestZip(file, handleProgress, {
        ...(importId ? { resumeImportId: importId } : {}),
        control: { isPaused: () => pausedRef.current, isCancelled: () => cancelledRef.current },
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem(zipKey(file), result.importId);
        window.localStorage.removeItem(SNAPSHOT_KEY);
      }
      if (!importId) adoptPendingLog(result.importId);
      rememberFailures(result.importId, result.failed);
      appendLog(
        result.importId,
        result.cancelled
          ? "Upload cancelled by you"
          : result.failed.length > 0
            ? `Finished with ${result.failed.length} failed file(s)`
            : `Upload complete — ${result.attachments.toLocaleString()} file(s) stored`,
      );


      if (result.cancelled) {
        toast.info(
          `Upload stopped — ${(result.attachments + result.skipped).toLocaleString()} file(s) are saved. Resume with the same zip to finish.`,
        );
      } else if (result.failed.length > 0) {
        toast.warning(
          `${result.attachments.toLocaleString()} files uploaded, ${result.failed.length.toLocaleString()} failed — open “Error details” on the import card to see why and retry just those.`,
        );
      } else {
        toast.success(
          result.skipped > 0
            ? `Resumed — ${result.skipped.toLocaleString()} files were already uploaded, ${result.attachments.toLocaleString()} added.`
            : `Imported ${result.messages.toLocaleString()} messages and ${result.attachments.toLocaleString()} files.`,
        );
      }
      if (!result.cancelled) {
        navigate({ to: "/archive/$importId", params: { importId: result.importId } });
      }
    } catch (error) {
      appendLog(importId, error instanceof Error ? `Failed — ${error.message}` : "Import failed");
      toast.error(
        error instanceof Error
          ? `${error.message} — everything uploaded so far is saved; resume with the same zip to continue.`
          : "Import failed.",
      );
    } finally {
      setBusy(false);
      setPaused(false);
      pausedRef.current = false;
      cancelledRef.current = false;
      setProgress(null);
      setRate(null);
      setResumeId(null);
      setActiveImportId(null);
    }
  };

  const percent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;
  const bytePercent =
    progress?.bytesTotal && progress.bytesTotal > 0
      ? Math.round(((progress.bytesDone ?? 0) / progress.bytesTotal) * 100)
      : null;


  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="font-serif text-xl tracking-tight text-foreground">Request Ledger</span>
          <div className="flex items-center gap-4">
            <Link to="/mappings" className="text-sm text-muted-foreground hover:text-foreground">
              Name mappings
            </Link>
            <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Internal tool</span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pt-20 pb-14">
        <p className="text-xs uppercase tracking-[0.3em] text-accent-foreground/70">Procurement record keeping</p>
        <h1 className="mt-5 max-w-3xl font-serif text-5xl leading-[1.05] text-foreground sm:text-6xl">
          A year of WhatsApp requests, turned into a ledger you can audit.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          Upload the full chat export — transcript, photos of requisitions, scanned invoices and payment
          receipts. Every document is read, matched to the conversation around it, and filed as a record with
          facility, items, amounts and dates.
        </p>

        <div className="mt-10">
            <div className="max-w-2xl rounded-xl border border-dashed border-border bg-card/60 p-8">
              <input
                ref={inputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                  event.target.value = "";
                }}
              />
              {busy ? (
                <div className="space-y-4">
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="text-sm text-foreground">{progress?.message ?? "Working…"}</p>
                    <span className="font-serif text-2xl tabular-nums text-foreground">
                      {percent ?? 0}%
                    </span>
                  </div>
                  <Progress value={percent ?? undefined} />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {(progress?.current ?? 0).toLocaleString()} of {(progress?.total ?? 0).toLocaleString()} files
                    </span>
                    {progress?.bytesTotal ? (
                      <span className="tabular-nums">
                        {formatBytes(progress.bytesDone ?? 0)} of {formatBytes(progress.bytesTotal)} uploaded
                        {bytePercent !== null ? ` (${bytePercent}%)` : ""}
                      </span>
                    ) : null}
                  </div>
                  {progress?.bytesTotal ? (
                    <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
                      <div>
                        <p className="uppercase tracking-[0.2em] text-muted-foreground">Speed</p>
                        <p className="mt-1 font-serif text-lg tabular-nums text-foreground">
                          {paused ? "Paused" : formatSpeed(rate?.bytesPerSecond ?? 0)}
                        </p>
                      </div>
                      <div>
                        <p className="uppercase tracking-[0.2em] text-muted-foreground">Time remaining</p>
                        <p className="mt-1 font-serif text-lg tabular-nums text-foreground">
                          {paused ? "—" : formatDuration(rate?.etaSeconds ?? 0)}
                        </p>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {paused ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          pausedRef.current = false;
                          setPaused(false);
                        }}
                      >
                        Resume
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancelledRef.current}
                        onClick={() => {
                          pausedRef.current = true;
                          setPaused(true);
                        }}
                      >
                        Pause
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        cancelledRef.current = true;
                        pausedRef.current = false;
                        setPaused(false);
                        toast.info("Stopping after the files in flight finish…");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {paused
                      ? "Paused — nothing is being sent. Everything uploaded so far is already saved."
                      : "Keep this tab open — the zip is unpacked here in your browser and streamed up file by file. Pausing or cancelling never loses uploaded files."}
                  </p>
                </div>

              ) : (
                <div className="space-y-4">
                  {snapshot ? (
                    <div className="space-y-3 rounded-lg border border-border/60 bg-card/60 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Upload interrupted
                      </p>
                      <p className="text-sm text-foreground">
                        {snapshot.zipName} stopped at{" "}
                        {snapshot.total > 0
                          ? `${snapshot.current.toLocaleString()} of ${snapshot.total.toLocaleString()} files`
                          : snapshot.message}
                        {snapshot.bytesTotal > 0
                          ? ` · ${formatBytes(snapshot.bytesDone)} of ${formatBytes(snapshot.bytesTotal)}`
                          : ""}{" "}
                        on {new Date(snapshot.updatedAt).toLocaleString()}.
                      </p>
                      {snapshot.total > 0 ? (
                        <Progress value={Math.round((snapshot.current / snapshot.total) * 100)} />
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setResumeId(snapshot.importId);
                            inputRef.current?.click();
                          }}
                        >
                          <Play className="size-4" />
                          Continue this upload
                        </Button>
                        {snapshot.importId ? (
                          <Button size="sm" variant="outline" onClick={() => setErrorsFor(snapshot.importId)}>
                            <AlertTriangle className="size-4" />
                            Retry failed items
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSnapshot(null);
                            if (typeof window !== "undefined") window.localStorage.removeItem(SNAPSHOT_KEY);
                          }}
                        >
                          Dismiss
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Your browser can&apos;t hold a multi-gigabyte file across a refresh, so pick the same zip
                        again — only the files still missing are sent.
                      </p>
                    </div>
                  ) : null}
                  <p className="font-serif text-xl text-foreground">Choose your WhatsApp export</p>
                  <p className="text-sm text-muted-foreground">
                    The whole zip, straight from WhatsApp&apos;s &ldquo;Export chat &rarr; Attach media&rdquo;.
                    Nothing is loaded into memory all at once, so multi-gigabyte exports are fine.
                  </p>

                  <Button
                    size="lg"
                    onClick={() => {
                      setResumeId(null);
                      inputRef.current?.click();
                    }}
                  >
                    Select zip file
                  </Button>
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button size="sm" variant="outline" disabled>
                      Resume
                    </Button>
                    <Button size="sm" variant="outline" disabled>
                      Pause
                    </Button>
                    <Button size="sm" variant="ghost" disabled>
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Resume, Pause and Cancel become active once an upload is running.
                  </p>
                </div>
              )}

            </div>

        </div>
      </section>

      <section className="border-y border-border/60 bg-card/40">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <div key={step.title}>
              <span className="font-serif text-3xl text-muted-foreground/50">{String(index + 1).padStart(2, "0")}</span>
              <h2 className="mt-3 text-base font-medium text-foreground">{step.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      {imports.length > 0 ? (
        <section className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="font-serif text-2xl text-foreground">Imports</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {imports.map((row) => (
              <Card key={row.id} className="border-border/60">
                <CardHeader className="pb-3">
                  <CardTitle className="truncate text-base font-medium">{row.filename}</CardTitle>
                  <CardDescription>{new Date(row.created_at).toLocaleString()}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary">{row.status}</Badge>
                    <span>{row.message_count.toLocaleString()} messages</span>
                    <span>·</span>
                    <span>{row.total_files.toLocaleString()} files</span>
                  </div>
                  {row.total_files > 0 ? (
                    <div className="space-y-1">
                      <Progress
                        value={Math.min(100, Math.round(((uploadedCounts[row.id] ?? 0) / row.total_files) * 100))}
                      />
                      <p className="text-xs text-muted-foreground">
                        {(uploadedCounts[row.id] ?? 0).toLocaleString()} of {row.total_files.toLocaleString()} files
                        uploaded
                        {(uploadedCounts[row.id] ?? 0) < row.total_files
                          ? ` · ${(row.total_files - (uploadedCounts[row.id] ?? 0)).toLocaleString()} remaining`
                          : ""}
                      </p>
                    </div>
                  ) : null}

                  {busy && activeImportId === row.id ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {paused ? "Paused" : progress?.message ?? "Uploading…"}
                      </p>
                      {!paused && rate ? (
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {formatSpeed(rate.bytesPerSecond)} · {formatDuration(rate.etaSeconds)} left
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <Collapsible
                    open={openLog === row.id}
                    onOpenChange={(open) => setOpenLog(open ? row.id : null)}
                  >
                    <CollapsibleTrigger asChild>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <ListChecks className="size-3.5" />
                        Processing log
                        {(logs[row.id]?.length ?? 0) > 0 ? ` (${logs[row.id]!.length})` : ""}
                        <ChevronDown
                          className={`size-3.5 transition-transform ${openLog === row.id ? "rotate-180" : ""}`}
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/50 p-2 text-xs">
                        {(logs[row.id] ?? []).length === 0 ? (
                          <li className="text-muted-foreground">
                            No steps recorded yet — they appear as this import runs.
                          </li>
                        ) : (
                          [...(logs[row.id] ?? [])].reverse().map((entry, index) => (
                            <li key={`${entry.at}-${index}`} className="flex gap-2">
                              <span className="tabular-nums text-muted-foreground">
                                {new Date(entry.at).toLocaleTimeString()}
                              </span>
                              <span className="text-foreground">{entry.label}</span>
                            </li>
                          ))
                        )}
                      </ol>
                    </CollapsibleContent>
                  </Collapsible>


                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link to="/archive/$importId" params={{ importId: row.id }}>
                        Open archive
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant={(failures[row.id]?.length ?? 0) > 0 ? "destructive" : "ghost"}
                      onClick={() => setErrorsFor(row.id)}
                    >
                      <AlertTriangle className="size-4" />
                      Error details
                      {(failures[row.id]?.length ?? 0) > 0 ? ` (${failures[row.id]!.length})` : ""}
                    </Button>
                    {(() => {
                      const isActive = busy && activeImportId === row.id;
                      const canResume = (!isActive && row.status !== "ready") || (isActive && paused);
                      const canPause = isActive && !paused;
                      const canCancel = isActive;
                      return (
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            title="Resume"
                            aria-label="Resume"
                            disabled={!canResume}
                            onClick={() => {
                              if (isActive && paused) {
                                pausedRef.current = false;
                                setPaused(false);
                              } else {
                                setResumeId(row.id);
                                inputRef.current?.click();
                              }
                            }}
                          >
                            <Play className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            title="Pause"
                            aria-label="Pause"
                            disabled={!canPause}
                            onClick={() => {
                              pausedRef.current = true;
                              setPaused(true);
                            }}
                          >
                            <Pause className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="Cancel"
                            aria-label="Cancel"
                            disabled={!canCancel}
                            onClick={() => {
                              cancelledRef.current = true;
                              pausedRef.current = false;
                              setPaused(false);
                              toast.info("Stopping after the files in flight finish…");
                            }}
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      );
                    })()}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <Sheet open={errorsFor !== null} onOpenChange={(open) => setErrorsFor(open ? errorsFor : null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {(() => {
            const row = imports.find((item) => item.id === errorsFor);
            const list = errorsFor ? failures[errorsFor] ?? [] : [];
            const last = list[list.length - 1];
            return (
              <>
                <SheetHeader>
                  <SheetTitle className="font-serif">Error details</SheetTitle>
                  <SheetDescription>{row?.filename ?? "This import"}</SheetDescription>
                </SheetHeader>
                <div className="space-y-5 px-4 pb-8">
                  <div className="rounded-lg border border-border/60 bg-card/60 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Last failure</p>
                    <p className="mt-2 text-sm text-foreground">
                      {last ? `${last.filename} — ${last.reason}` : row?.notes ?? "No failures recorded for this import."}
                    </p>
                  </div>

                  {list.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        {list.length.toLocaleString()} file(s) failed to upload
                      </p>
                      <ul className="max-h-72 space-y-2 overflow-y-auto text-sm">
                        {list.map((failure) => (
                          <li key={failure.filename} className="rounded-md border border-border/50 p-3">
                            <p className="truncate font-medium text-foreground">{failure.filename}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{failure.reason}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={!errorsFor || busy}
                      onClick={() => errorsFor && retryFailedUploads(errorsFor)}
                    >
                      <RotateCcw className="size-4" />
                      Retry failed uploads
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!errorsFor || requeuing}
                      onClick={() => errorsFor && void retryFailedParses(errorsFor)}
                    >
                      Re-queue failed reads
                    </Button>
                    {list.length > 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => errorsFor && rememberFailures(errorsFor, [])}
                      >
                        Clear list
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Retrying uploads sends only the files missing from this import — everything already stored is
                    untouched. Re-queueing failed reads puts files that failed extraction back in the parse queue.
                  </p>
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
    </main>
  );
}
