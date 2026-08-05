import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  finishProcessingRun,
  processAttachmentBatch,
  rebuildRecords,
  retryFailedAttachments,
  startProcessingRun,
  getAttachmentPreview,
  reprocessAttachment,
  listImportFiles,
  requeueAttachments,
  setAttachmentSkipped,
  getUnmatchedReport,
  getRecordEvidence,
} from "@/lib/processing.functions";



import type { Issue } from "@/lib/data-rules";
import { exportRecordsToXlsx } from "@/lib/export-xlsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RecordItem = { name: string; quantity: number | null; unit: string | null; amount: number | null };

type RequestRecord = {
  id: string;
  facility_name: string | null;
  items: RecordItem[];
  amount_paid: number | null;
  currency: string | null;
  request_date: string | null;
  payment_date: string | null;
  requester_name: string | null;
  requester_phone: string | null;
  status: string;
  confidence: number | null;
  needs_review: boolean;
  issues: Issue[];
  notes: string | null;
};

type MessageRow = {
  id: string;
  seq: number;
  sent_at: string | null;
  sender: string | null;
  body: string | null;
  attachment_filename: string | null;
};

type Counts = { pending: number; done: number; error: number; skipped: number; deferred: number };

/** Files at or above this size are read alone on the heavy lane. */
const HEAVY_FILE_BYTES = 4 * 1024 * 1024;

type RecordEvidence = {
  attachments: { id: string; filename: string; mimeType: string | null; ocrStatus: string; url: string | null }[];
  messages: { id: string; seq: number; sent_at: string | null; sender: string | null; body: string | null }[];
};

type UnmatchedReport = {
  unmatchedFiles: {
    id: string;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    messageSeq: number | null;
    status: string;
    docType: string | null;
    reason: string;
  }[];
  unmatchedMessages: {
    id: string;
    seq: number;
    sentAt: string | null;
    sender: string | null;
    snippet: string;
    filename: string | null;
    reason: string;
  }[];
  totalFiles: number;
  totalRecords: number;
};

type FileRow = {

  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  ocr_status: string;
  ocr_error: string | null;
  message_seq: number | null;
  processed_at: string | null;
};


type RunRow = {
  id: string;
  status: string;
  concurrency: number;
  chunk_size: number;
  total_files: number;
  processed_count: number;
  failed_count: number;
  notes: string | null;
  started_at: string;
  finished_at: string | null;
};

type Preview = {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  ocrStatus: string;
  ocrError: string | null;
  rawText: string | null;
  extracted: unknown;
  url: string | null;
  mismatches: Issue[];
  chatContext: { seq: number; sent_at: string | null; sender: string | null; body: string | null }[];
};


type LiveFile = {
  attachmentId: string;
  filename: string;
  outcome: string;
  confidence: number | null;
  durationMs: number;
  attempts: number;
  error: string | null;
};

type EventRow = {

  id: string;
  attachment_id: string | null;
  filename: string;
  outcome: string;
  doc_type: string | null;
  confidence: number | null;
  field_confidence: Record<string, number | null> | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
};



export const Route = createFileRoute("/archive/$importId")({
  head: () => ({
    meta: [
      { title: "Archive — Request Ledger" },
      {
        name: "description",
        content:
          "Search the imported WhatsApp conversation, review extracted supply requests and payments, and export the ledger to Excel.",
      },
      { property: "og:title", content: "Archive — Request Ledger" },
      {
        property: "og:description",
        content: "Searchable record of facility supply requests parsed from a WhatsApp export.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ArchivePage,
});

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  return `${currency ? `${currency} ` : ""}${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatConfidence(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function ArchivePage() {
  const { importId } = Route.useParams();
  const runBatch = useServerFn(processAttachmentBatch);
  const runRebuild = useServerFn(rebuildRecords);
  const runRetry = useServerFn(retryFailedAttachments);
  const beginRun = useServerFn(startProcessingRun);
  const endRun = useServerFn(finishProcessingRun);
  const fetchPreview = useServerFn(getAttachmentPreview);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const openPreview = useCallback(
    async (attachmentId: string | null) => {
      if (!attachmentId) {
        toast.error("This log entry has no stored file to preview.");
        return;
      }
      setPreviewLoading(true);
      setPreview(null);
      try {
        const result = await fetchPreview({ data: { attachmentId } });
        setPreview(result as Preview);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not open that file.");
      } finally {
        setPreviewLoading(false);
      }
    },
    [fetchPreview],
  );

  const [importName, setImportName] = useState("");
  const [counts, setCounts] = useState<Counts>({ pending: 0, done: 0, error: 0, skipped: 0, deferred: 0 });
  const [records, setRecords] = useState<RequestRecord[]>([]);
  const [reading, setReading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [facilityFilter, setFacilityFilter] = useState("");
  const [contactFilter, setContactFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, RecordEvidence>>({});
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null);
  const [report, setReport] = useState<UnmatchedReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const fetchReport = useServerFn(getUnmatchedReport);
  const fetchEvidence = useServerFn(getRecordEvidence);


  const [concurrency, setConcurrency] = useState("4");
  const [chunkSize, setChunkSize] = useState("3");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventFilter, setEventFilter] = useState("all");
  const [liveFiles, setLiveFiles] = useState<LiveFile[]>([]);
  const [liveTotal, setLiveTotal] = useState(0);
  const [liveDone, setLiveDone] = useState(0);
  const [liveFailed, setLiveFailed] = useState(0);
  const [liveDeferred, setLiveDeferred] = useState(0);
  const [liveStart, setLiveStart] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [reprocessing, setReprocessing] = useState<string | null>(null);
  const runOne = useServerFn(reprocessAttachment);

  // Parse-run pause: lanes check this between chunks, and the flag survives a
  // reload so a closed tab doesn't silently resume a run.
  const pauseKey = `parse-paused:${importId}`;
  const [parsePaused, setParsePaused] = useState(false);
  const parsePausedRef = useRef(false);
  const parseStoppedRef = useRef(false);
  useEffect(() => {
    const stored = typeof window !== "undefined" && window.localStorage.getItem(pauseKey) === "1";
    parsePausedRef.current = stored;
    setParsePaused(stored);
  }, [pauseKey]);
  const setPaused = useCallback(
    (value: boolean) => {
      parsePausedRef.current = value;
      setParsePaused(value);
      if (typeof window !== "undefined") {
        if (value) window.localStorage.setItem(pauseKey, "1");
        else window.localStorage.removeItem(pauseKey);
      }
    },
    [pauseKey],
  );

  // Files tab
  const loadFiles = useServerFn(listImportFiles);
  const requeue = useServerFn(requeueAttachments);
  const markSkipped = useServerFn(setAttachmentSkipped);
  const [fileRows, setFileRows] = useState<FileRow[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [filePage, setFilePage] = useState(0);
  const [fileStatus, setFileStatus] = useState("all");
  const [fileSearch, setFileSearch] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const FILE_PAGE_SIZE = 50;


  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reading]);


  const [messageQuery, setMessageQuery] = useState("");
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [searching, setSearching] = useState(false);

  const loadCounts = useCallback(async () => {
    const statuses: (keyof Counts)[] = ["pending", "done", "error", "skipped", "deferred"];
    const next: Counts = { pending: 0, done: 0, error: 0, skipped: 0, deferred: 0 };
    await Promise.all(
      statuses.map(async (status) => {
        const { count } = await supabase
          .from("attachments")
          .select("id", { count: "exact", head: true })
          .eq("import_id", importId)
          .eq("ocr_status", status);
        next[status] = count ?? 0;
      }),
    );
    setCounts(next);
  }, [importId]);

  const loadRuns = useCallback(async () => {
    const { data } = await supabase
      .from("processing_runs")
      .select(
        "id, status, concurrency, chunk_size, total_files, processed_count, failed_count, notes, started_at, finished_at",
      )
      .eq("import_id", importId)
      .order("started_at", { ascending: false })
      .limit(25);
    setRuns((data ?? []) as RunRow[]);
    setActiveRunId((current) => current ?? data?.[0]?.id ?? null);
  }, [importId]);

  const loadEvents = useCallback(async (runId: string | null) => {
    if (!runId) {
      setEvents([]);
      return;
    }
    const { data } = await supabase
      .from("processing_events")
      .select("id, attachment_id, filename, outcome, doc_type, confidence, field_confidence, duration_ms, error, created_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(1000);
    setEvents(
      (data ?? []).map((row) => ({
        ...row,
        field_confidence: (row.field_confidence ?? null) as EventRow["field_confidence"],
      })),
    );
  }, []);

  const loadRecords = useCallback(async () => {
    const { data, error } = await supabase
      .from("request_records")
      .select(
        "id, facility_name, items, amount_paid, currency, request_date, payment_date, requester_name, requester_phone, status, confidence, needs_review, issues, notes",
      )
      .eq("import_id", importId)
      .order("request_date", { ascending: true, nullsFirst: false })
      .limit(5000);
    if (error) {
      toast.error(error.message);
      return;
    }
    setRecords(
      (data ?? []).map((row) => ({
        ...row,
        items: Array.isArray(row.items) ? (row.items as unknown as RecordItem[]) : [],
        issues: Array.isArray(row.issues) ? (row.issues as unknown as Issue[]) : [],
      })),
    );
  }, [importId]);

  useEffect(() => {
    supabase
      .from("imports")
      .select("filename")
      .eq("id", importId)
      .maybeSingle()
      .then(({ data }) => setImportName(data?.filename ?? ""));
    void loadCounts();
    void loadRecords();
    void loadRuns();
  }, [importId, loadCounts, loadRecords, loadRuns]);

  useEffect(() => {
    void loadEvents(activeRunId);
  }, [activeRunId, loadEvents]);

  const refreshFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const result = await loadFiles({
        data: { importId, status: fileStatus, search: fileSearch, page: filePage, pageSize: FILE_PAGE_SIZE },
      });
      setFileRows(result.files as FileRow[]);
      setFileTotal(result.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the file list.");
    } finally {
      setFilesLoading(false);
    }
  }, [importId, fileStatus, fileSearch, filePage, loadFiles]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  const requeueScope = async (scope: "failed" | "stuck" | "skipped" | "deferred") => {
    try {
      const result = await requeue({ data: { importId, scope } });
      toast.success(`${result.requeued.toLocaleString()} file(s) moved back into the queue.`);
      await Promise.all([loadCounts(), refreshFiles()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue those files.");
    }
  };

  const requeueOne = async (attachmentId: string) => {
    setRowBusy(attachmentId);
    try {
      await requeue({ data: { importId, scope: "ids", attachmentIds: [attachmentId] } });
      toast.success("Queued for another read.");
      await Promise.all([loadCounts(), refreshFiles()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue that file.");
    } finally {
      setRowBusy(null);
    }
  };

  const skipOne = async (attachmentId: string) => {
    setRowBusy(attachmentId);
    try {
      await markSkipped({ data: { attachmentId } });
      toast.success("File will be left out of future runs.");
      await Promise.all([loadCounts(), refreshFiles()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not skip that file.");
    } finally {
      setRowBusy(null);
    }
  };

  const readAll = async () => {
    setPaused(false);
    parseStoppedRef.current = false;
    setReading(true);
    setLiveFiles([]);
    setLiveDone(0);
    setLiveFailed(0);
    setLiveDeferred(0);
    setLiveStart(Date.now());
    const lanes = Number(concurrency);
    const chunk = Number(chunkSize);
    let runId: string | null = null;
    let stopped = false;
    let stopReason: string | null = null;

    try {
      const started = await beginRun({
        data: { importId, concurrency: lanes, chunkSize: chunk, retryFailed: true },
      });
      runId = started.runId;
      setActiveRunId(runId);
      setLiveTotal(started.totalFiles);
      if (started.requeued > 0) {
        toast.info(`${started.requeued.toLocaleString()} previously failed files were queued again.`);
      }
      await loadRuns();

      // Each lane pulls its own chunk of files; the backend hands out
      // non-overlapping batches, so lanes never read the same document.
      // Small files go through the parallel lanes; large ones get a lane of
      // their own (one file at a time) so nothing has to be skipped.
      const lane = async (band: { limit: number; minBytes?: number; maxBytes?: number }) => {
        for (;;) {
          if (stopped) return;
          if (parseStoppedRef.current) {
            stopped = true;
            stopReason = "Stopped by hand";
            return;
          }
          // Pausing idles the lane between chunks — files already read stay read.
          while (parsePausedRef.current && !parseStoppedRef.current) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (parseStoppedRef.current) {
            stopped = true;
            stopReason = "Stopped by hand";
            return;
          }
          // A single failed round trip (server hiccup, dropped connection)
          // must not end the whole run — back off and try the chunk again.
          let result: Awaited<ReturnType<typeof runBatch>> | null = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              result = await runBatch({
                data: {
                  importId,
                  limit: band.limit,
                  runId,
                  minBytes: band.minBytes ?? null,
                  maxBytes: band.maxBytes ?? null,
                },
              });
              break;
            } catch (batchError) {
              if (attempt === 3) throw batchError;
              await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
            }
          }
          if (!result) return;

          if (result.files.length) {
            setLiveFiles((current) => [...result.files, ...current].slice(0, 40));
          }
          setLiveDone((current) => current + result.processed);
          setLiveFailed((current) => current + result.failed);
          if (result.deferred) setLiveDeferred((current) => current + result.deferred);
          void loadCounts();
          if (result.creditsExhausted) {
            stopped = true;
            stopReason = "AI credits exhausted";
            toast.error("AI credits are exhausted. Top up your workspace credits to continue reading documents.");
            return;
          }
          if (result.rateLimited) {
            await new Promise((resolve) => setTimeout(resolve, 8000));
            continue;
          }
          if (result.processed === 0 && result.failed === 0 && result.deferred === 0) return;
        }
      };

      await Promise.all([
        ...Array.from({ length: lanes }, () => lane({ limit: chunk, maxBytes: HEAVY_FILE_BYTES })),
        // Heavy lane: one big document at a time, in parallel with the rest.
        lane({ limit: 1, minBytes: HEAVY_FILE_BYTES }),
      ]);

      await endRun({ data: { runId, status: stopped ? "stopped" : "completed", notes: stopReason } });
      if (!stopped) toast.success("Reading finished.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reading stopped unexpectedly.";
      toast.error(message);
      if (runId) await endRun({ data: { runId, status: "error", notes: message } });
    } finally {
      setReading(false);
      setPaused(false);
      parseStoppedRef.current = false;
      setLiveStart(null);
      void refreshFiles();

      void loadCounts();
      void loadRuns();
      void loadEvents(runId ?? activeRunId);
    }
  };

  const reprocessFile = useCallback(
    async (attachmentId: string | null) => {
      if (!attachmentId) {
        toast.error("This log entry has no stored file to reprocess.");
        return;
      }
      setReprocessing(attachmentId);
      try {
        const result = await runOne({ data: { attachmentId, runId: activeRunId } });
        if (result.ok) {
          toast.success(`${result.filename} re-read successfully.`);
        } else {
          toast.error(result.error ?? "That file could not be read.");
        }
        void loadCounts();
        void loadEvents(activeRunId);
        if (preview?.id === attachmentId) {
          const refreshed = await fetchPreview({ data: { attachmentId } });
          setPreview(refreshed as Preview);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not reprocess that file.");
      } finally {
        setReprocessing(null);
      }
    },
    [runOne, activeRunId, loadCounts, loadEvents, preview?.id, fetchPreview],
  );



  const build = async () => {
    setBuilding(true);
    try {
      const result = await runRebuild({ data: { importId } });
      await loadRecords();
      toast.success(`${result.records} records built · ${result.needsReview} need a look.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the ledger.");
    } finally {
      setBuilding(false);
    }
  };

  const retry = async () => {
    try {
      const result = await runRetry({ data: { importId } });
      await loadCounts();
      toast.success(`${result.requeued} documents queued again.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not requeue.");
    }
  };

  const searchMessages = async () => {
    setSearching(true);
    try {
      let request = supabase
        .from("messages")
        .select("id, seq, sent_at, sender, body, attachment_filename")
        .eq("import_id", importId)
        .order("seq", { ascending: true })
        .limit(200);
      if (messageQuery.trim()) request = request.ilike("body", `%${messageQuery.trim()}%`);
      const { data, error } = await request;
      if (error) throw new Error(error.message);
      setMessages(data ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  };

  const loadReport = useCallback(async () => {
    setReportLoading(true);
    try {
      const result = await fetchReport({ data: { importId } });
      setReport(result as UnmatchedReport);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the report.");
    } finally {
      setReportLoading(false);
    }
  }, [fetchReport, importId]);

  const toggleEvidence = async (recordId: string) => {
    if (expandedRecord === recordId) {
      setExpandedRecord(null);
      return;
    }
    setExpandedRecord(recordId);
    if (evidence[recordId]) return;
    setEvidenceLoading(recordId);
    try {
      const result = await fetchEvidence({ data: { recordId } });
      setEvidence((current) => ({ ...current, [recordId]: result as RecordEvidence }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the matched files.");
    } finally {
      setEvidenceLoading(null);
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const facilityNeedle = facilityFilter.trim().toLowerCase();
    const contactNeedle = contactFilter.trim().toLowerCase();
    return records.filter((record) => {
      if (statusFilter === "review" && !record.needs_review) return false;
      if (statusFilter === "paid" && record.status !== "paid") return false;
      if (statusFilter === "unpaid" && record.payment_date) return false;
      if (facilityNeedle && !(record.facility_name ?? "").toLowerCase().includes(facilityNeedle)) return false;
      if (contactNeedle) {
        const contact = `${record.requester_name ?? ""} ${record.requester_phone ?? ""}`.toLowerCase();
        if (!contact.includes(contactNeedle)) return false;
      }
      if (fromDate || toDate) {
        const stamp = record.request_date ?? record.payment_date;
        if (!stamp) return false;
        if (fromDate && stamp < fromDate) return false;
        if (toDate && stamp > toDate) return false;
      }
      if (!needle) return true;
      const haystack = [
        record.facility_name,
        record.requester_name,
        record.requester_phone,
        record.notes,
        ...record.items.map((item) => item.name),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [records, query, statusFilter, facilityFilter, contactFilter, fromDate, toDate]);


  const activeRun = useMemo(() => runs.find((run) => run.id === activeRunId) ?? null, [runs, activeRunId]);

  const visibleEvents = useMemo(() => {
    if (eventFilter === "all") return events;
    if (eventFilter === "low") return events.filter((event) => (event.confidence ?? 1) < 0.6);
    if (eventFilter === "error") return events.filter((event) => event.outcome !== "done");
    return events.filter((event) => event.outcome === "done");
  }, [events, eventFilter]);


  const totalRead = counts.done + counts.error;
  const totalReadable = counts.pending + totalRead;
  const readPercent = totalReadable ? Math.round((totalRead / totalReadable) * 100) : 0;
  const totalPaid = filtered.reduce((sum, record) => sum + (record.amount_paid ?? 0), 0);

  const liveHandled = liveDone + liveFailed + liveDeferred;
  const livePercent = liveTotal ? Math.min(100, Math.round((liveHandled / liveTotal) * 100)) : readPercent;
  const elapsedMs = liveStart ? nowTick - liveStart : 0;
  const perFileMs = liveHandled > 0 && elapsedMs > 0 ? elapsedMs / liveHandled : 0;
  const etaMs = perFileMs > 0 ? perFileMs * Math.max(0, liveTotal - liveHandled) : 0;
  const formatDuration = (ms: number) => {
    if (!ms || !Number.isFinite(ms)) return "—";
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };


  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-5">
          <div>
            <Link to="/" className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
              Request Ledger
            </Link>
            <h1 className="font-serif text-2xl text-foreground">{importName || "Archive"}</h1>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              exportRecordsToXlsx(filtered, `request-ledger-${new Date().toISOString().slice(0, 10)}.xlsx`)
            }
            disabled={filtered.length === 0}
          >
            Export {filtered.length.toLocaleString()} rows to Excel
          </Button>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-6 py-8">
        <div className="rounded-xl border border-border/60 bg-card/60 p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-serif text-xl text-foreground">Document reading</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {counts.done.toLocaleString()} read · {counts.pending.toLocaleString()} waiting ·{" "}
                {counts.error.toLocaleString()} failed · {counts.deferred.toLocaleString()} held back ·{" "}
                {counts.skipped.toLocaleString()} not readable
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Lanes</p>
                <Select value={concurrency} onValueChange={setConcurrency} disabled={reading}>
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["1", "2", "3", "4", "6", "8"].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Per chunk</p>
                <Select value={chunkSize} onValueChange={setChunkSize} disabled={reading}>
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["1", "2", "3", "4"].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={readAll} disabled={reading || counts.pending === 0}>
                {reading ? (parsePaused ? "Paused" : "Reading…") : "Read pending documents"}
              </Button>
              {reading ? (
                <>
                  <Button variant="outline" onClick={() => setPaused(!parsePaused)}>
                    {parsePaused ? "Resume reading" : "Pause reading"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      parseStoppedRef.current = true;
                      setPaused(false);
                    }}
                  >
                    Stop
                  </Button>
                </>
              ) : null}
              {counts.error > 0 ? (
                <Button variant="outline" onClick={retry} disabled={reading}>
                  Retry failed
                </Button>
              ) : null}

              <Button variant="secondary" onClick={build} disabled={building || counts.done === 0}>
                {building ? "Building…" : "Build ledger"}
              </Button>
            </div>
          </div>
          <Progress className="mt-5" value={reading ? livePercent : readPercent} />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              {concurrency} lanes × {chunkSize} files per chunk — up to{" "}
              {Number(concurrency) * Number(chunkSize)} documents read at once.
            </span>
            {reading ? (
              <span className="text-foreground">
                {liveHandled.toLocaleString()} / {liveTotal.toLocaleString()} files ·{" "}
                {liveFailed.toLocaleString()} failed · {liveDeferred.toLocaleString()} held back · elapsed {formatDuration(elapsedMs)} ·{" "}
                {etaMs > 0 ? `about ${formatDuration(etaMs)} left` : "estimating…"}
                {perFileMs > 0 ? ` · ${(perFileMs / 1000).toFixed(1)}s per file` : ""}
              </span>
            ) : null}
          </div>

          {reading || liveFiles.length > 0 ? (
            <div className="mt-4 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 bg-card/40 p-3">
              {liveFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">Waiting for the first file to come back…</p>
              ) : (
                liveFiles.map((file, index) => (
                  <div
                    key={`${file.attachmentId}-${index}`}
                    className="flex flex-wrap items-center gap-2 text-xs"
                  >
                    <Badge variant={file.outcome === "done" ? "default" : "outline"}>{file.outcome}</Badge>
                    <span className="max-w-[18rem] truncate font-mono">{file.filename}</span>
                    <span className="text-muted-foreground">{(file.durationMs / 1000).toFixed(1)}s</span>
                    {file.attempts > 1 ? (
                      <span className="text-muted-foreground">retried {file.attempts - 1}×</span>
                    ) : null}
                    {file.confidence !== null ? (
                      <span className="text-muted-foreground">{formatConfidence(file.confidence)}</span>
                    ) : null}
                    {file.error ? <span className="text-destructive">{file.error}</span> : null}
                    {file.outcome !== "done" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        disabled={reprocessing === file.attachmentId}
                        onClick={() => void reprocessFile(file.attachmentId)}
                      >
                        {reprocessing === file.attachmentId ? "Reprocessing…" : "Reprocess"}
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          ) : null}

        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-20">
        <Tabs defaultValue="records">
          <TabsList>
            <TabsTrigger value="records">Ledger</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="messages">Conversation</TabsTrigger>
            <TabsTrigger value="log">Run log</TabsTrigger>
          </TabsList>

          <TabsContent value="files" className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Input
                placeholder="Search file name…"
                value={fileSearch}
                onChange={(event) => {
                  setFilePage(0);
                  setFileSearch(event.target.value);
                }}
                className="max-w-xs"
              />
              <Select
                value={fileStatus}
                onValueChange={(value) => {
                  setFilePage(0);
                  setFileStatus(value);
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All files</SelectItem>
                  <SelectItem value="pending">Waiting</SelectItem>
                  <SelectItem value="processing">In progress</SelectItem>
                  <SelectItem value="done">Read</SelectItem>
                  <SelectItem value="error">Failed</SelectItem>
                  <SelectItem value="deferred">Held back</SelectItem>
                  <SelectItem value="skipped">Skipped</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={() => void requeueScope("failed")} disabled={counts.error === 0}>
                Queue all failed
              </Button>
              <Button variant="outline" onClick={() => void requeueScope("stuck")}>
                Unstick in-progress
              </Button>
              <Button variant="outline" onClick={() => void requeueScope("skipped")}>
                Queue skipped
              </Button>
              <Button
                variant="outline"
                onClick={() => void requeueScope("deferred")}
                disabled={counts.deferred === 0}
              >
                Queue held back
              </Button>
              <Button variant="ghost" onClick={() => void refreshFiles()} disabled={filesLoading}>
                {filesLoading ? "Refreshing…" : "Refresh"}
              </Button>
            </div>

            <div className="overflow-hidden rounded-xl border border-border/60">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">File</th>
                    <th className="px-4 py-3">State</th>
                    <th className="px-4 py-3">Detail</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {fileRows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                        {filesLoading ? "Loading files…" : "No files match this filter."}
                      </td>
                    </tr>
                  ) : (
                    fileRows.map((row) => (
                      <tr key={row.id} className="border-t border-border/50 align-top">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="text-left font-medium text-foreground underline-offset-4 hover:underline"
                            onClick={() => void openPreview(row.id)}
                          >
                            {row.filename}
                          </button>
                          <p className="text-xs text-muted-foreground">
                            {row.mime_type ?? "unknown type"}
                            {row.size_bytes ? ` · ${(row.size_bytes / 1024).toFixed(0)} KB` : ""}
                            {row.message_seq != null ? ` · message #${row.message_seq}` : ""}
                          </p>
                        </td>
                        <td className="px-4 py-3 capitalize">{row.ocr_status}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {row.ocr_error ?? (row.processed_at ? new Date(row.processed_at).toLocaleString() : "—")}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={rowBusy === row.id}
                              onClick={() => void requeueOne(row.id)}
                            >
                              Queue again
                            </Button>
                            {row.ocr_status !== "skipped" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={rowBusy === row.id}
                                onClick={() => void skipOne(row.id)}
                              >
                                Skip
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {fileTotal.toLocaleString()} file(s) · page {filePage + 1} of{" "}
                {Math.max(1, Math.ceil(fileTotal / FILE_PAGE_SIZE))}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filePage === 0}
                  onClick={() => setFilePage((page) => Math.max(0, page - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(filePage + 1) * FILE_PAGE_SIZE >= fileTotal}
                  onClick={() => setFilePage((page) => page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </TabsContent>




          <TabsContent value="records" className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Input
                placeholder="Search facility, item, contact…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="max-w-sm"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All records</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="unpaid">Awaiting payment</SelectItem>
                  <SelectItem value="review">Needs review</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Facility…"
                value={facilityFilter}
                onChange={(event) => setFacilityFilter(event.target.value)}
                className="max-w-[12rem]"
              />
              <Input
                placeholder="Contact name or phone…"
                value={contactFilter}
                onChange={(event) => setContactFilter(event.target.value)}
                className="max-w-[14rem]"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">From</span>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(event) => setFromDate(event.target.value)}
                  className="w-[10rem]"
                />
                <span className="text-xs uppercase tracking-wider text-muted-foreground">To</span>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(event) => setToDate(event.target.value)}
                  className="w-[10rem]"
                />
              </div>
              {query || facilityFilter || contactFilter || fromDate || toDate || statusFilter !== "all" ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    setFacilityFilter("");
                    setContactFilter("");
                    setFromDate("");
                    setToDate("");
                    setStatusFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
              <span className="text-sm text-muted-foreground">
                {filtered.length.toLocaleString()} of {records.length.toLocaleString()} records ·{" "}
                {formatMoney(totalPaid, filtered[0]?.currency ?? null)} recorded
              </span>
            </div>


            <div className="overflow-x-auto rounded-xl border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-44">Facility</TableHead>
                    <TableHead className="min-w-72">Items &amp; quantities</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead className="min-w-40">Contact</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                        No records yet. Read the documents, then build the ledger.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((record) => (
                      <TableRow key={record.id} className="align-top">
                        <TableCell className="font-medium">{record.facility_name ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {record.items.length === 0
                            ? "—"
                            : record.items.map((item, index) => (
                                <div key={`${record.id}-${index}`}>
                                  {item.quantity !== null ? `${item.quantity}${item.unit ? ` ${item.unit}` : ""} × ` : ""}
                                  {item.name}
                                  {item.amount !== null ? ` — ${item.amount.toLocaleString()}` : ""}
                                </div>
                              ))}
                        </TableCell>
                        <TableCell>{formatMoney(record.amount_paid, record.currency)}</TableCell>
                        <TableCell>{record.request_date ?? "—"}</TableCell>
                        <TableCell>{record.payment_date ?? "—"}</TableCell>
                        <TableCell className="text-sm">
                          <div>{record.requester_name ?? "—"}</div>
                          <div className="text-muted-foreground">{record.requester_phone ?? ""}</div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant={record.status === "paid" ? "default" : "secondary"}>
                              {record.status}
                            </Badge>
                            {record.needs_review ? <Badge variant="outline">review</Badge> : null}
                            {record.issues.map((issue, index) => (
                              <span
                                key={`${record.id}-issue-${index}`}
                                className={
                                  issue.level === "error"
                                    ? "text-xs text-destructive"
                                    : "text-xs text-muted-foreground"
                                }
                              >
                                {issue.message}
                              </span>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="messages" className="mt-6 space-y-4">
            <div className="flex flex-wrap gap-3">
              <Input
                placeholder="Search the conversation…"
                value={messageQuery}
                onChange={(event) => setMessageQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchMessages();
                }}
                className="max-w-sm"
              />
              <Button variant="outline" onClick={searchMessages} disabled={searching}>
                {searching ? "Searching…" : "Search"}
              </Button>
            </div>
            <div className="space-y-3">
              {messages.map((message) => (
                <div key={message.id} className="rounded-lg border border-border/60 bg-card/40 p-4">
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>#{message.seq}</span>
                    <span>{message.sent_at ? new Date(message.sent_at).toLocaleString() : "no date"}</span>
                    <span className="text-foreground">{message.sender ?? "system"}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{message.body}</p>
                  {message.attachment_filename ? (
                    <p className="mt-2 text-xs text-muted-foreground">📎 {message.attachment_filename}</p>
                  ) : null}
                </div>
              ))}
              {messages.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Search the transcript to see messages here.
                </p>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="log" className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={activeRunId ?? ""} onValueChange={setActiveRunId}>
                <SelectTrigger className="w-[26rem]">
                  <SelectValue placeholder="No runs yet" />
                </SelectTrigger>
                <SelectContent>
                  {runs.map((run) => (
                    <SelectItem key={run.id} value={run.id}>
                      {new Date(run.started_at).toLocaleString()} · {run.status} · {run.processed_count} ok /{" "}
                      {run.failed_count} failed
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={eventFilter} onValueChange={setEventFilter}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All files</SelectItem>
                  <SelectItem value="done">Parsed</SelectItem>
                  <SelectItem value="error">Errors</SelectItem>
                  <SelectItem value="low">Low confidence</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={() => void loadEvents(activeRunId)}>
                Refresh
              </Button>
            </div>

            {activeRun ? (
              <div className="rounded-lg border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
                {activeRun.total_files.toLocaleString()} files queued · {activeRun.concurrency} lanes ×{" "}
                {activeRun.chunk_size} per chunk · started {new Date(activeRun.started_at).toLocaleString()}
                {activeRun.finished_at
                  ? ` · finished ${new Date(activeRun.finished_at).toLocaleString()}`
                  : " · running"}
                {activeRun.notes ? ` · ${activeRun.notes}` : ""}
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-xl border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Field confidence</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead className="text-right">Action</TableHead>

                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                        No log entries yet — run the reader to record one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleEvents.map((event) => (
                      <TableRow
                        key={event.id}
                        className="cursor-pointer"
                        onClick={() => void openPreview(event.attachment_id)}
                      >
                        <TableCell className="max-w-[18rem] truncate font-mono text-xs underline decoration-dotted underline-offset-4">
                          {event.filename}
                        </TableCell>
                        <TableCell>
                          <Badge variant={event.outcome === "done" ? "default" : "outline"}>{event.outcome}</Badge>
                          {event.error ? (
                            <p className="mt-1 max-w-[20rem] text-xs text-muted-foreground">{event.error}</p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm">{event.doc_type ?? "—"}</TableCell>
                        <TableCell className="text-sm">{formatConfidence(event.confidence)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {event.field_confidence
                            ? Object.entries(event.field_confidence as Record<string, number | null>)
                                .filter(([, value]) => typeof value === "number")
                                .map(([key, value]) => `${key} ${formatConfidence(value as number)}`)
                                .join(" · ") || "—"
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={reprocessing === event.attachment_id || !event.attachment_id}
                            onClick={(clickEvent) => {
                              clickEvent.stopPropagation();
                              void reprocessFile(event.attachment_id);
                            }}
                          >
                            {reprocessing === event.attachment_id ? "Reprocessing…" : "Reprocess"}
                          </Button>
                        </TableCell>
                      </TableRow>

                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>

      </section>

      <Sheet
        open={previewLoading || preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="break-all font-mono text-sm">
              {preview?.filename ?? "Opening file…"}
            </SheetTitle>
            <SheetDescription>
              {preview
                ? `${preview.mimeType ?? "unknown type"}${
                    preview.sizeBytes ? ` · ${(preview.sizeBytes / 1024).toFixed(0)} KB` : ""
                  } · ${preview.ocrStatus}`
                : "Fetching the stored file and its extracted text."}
            </SheetDescription>
          </SheetHeader>

          {preview ? (
            <div className="space-y-5 px-4 pb-8">
              {preview.url ? (
                preview.mimeType?.includes("pdf") ? (
                  <object
                    data={preview.url}
                    type="application/pdf"
                    className="h-96 w-full rounded-lg border border-border/60"
                  >
                    <a href={preview.url} target="_blank" rel="noreferrer" className="text-sm underline">
                      Open the PDF in a new tab
                    </a>
                  </object>
                ) : (
                  <a href={preview.url} target="_blank" rel="noreferrer">
                    <img
                      src={preview.url}
                      alt={`Scanned document ${preview.filename}`}
                      loading="lazy"
                      className="max-h-96 w-full rounded-lg border border-border/60 object-contain"
                    />
                  </a>
                )
              ) : (
                <p className="text-sm text-muted-foreground">The stored file could not be opened.</p>
              )}

              {preview.ocrError ? (
                <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
                  {preview.ocrError}
                </p>
              ) : null}

              <Button
                variant="outline"
                disabled={reprocessing === preview.id}
                onClick={() => void reprocessFile(preview.id)}
              >
                {reprocessing === preview.id ? "Reprocessing…" : "Reprocess this file"}
              </Button>

              <div>
                <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Chat vs file checks
                </h3>
                {preview.mismatches.length === 0 ? (
                  <p className="mt-2 rounded-lg border border-border/60 bg-card/40 p-3 text-sm text-muted-foreground">
                    The facility, requester and dates on this file agree with the surrounding chat.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {preview.mismatches.map((issue, index) => (
                      <li
                        key={index}
                        className={`rounded-lg border p-3 text-sm ${
                          issue.level === "error"
                            ? "border-destructive/50 bg-destructive/10 text-destructive"
                            : "border-primary/40 bg-primary/5 text-foreground"
                        }`}
                      >
                        <span className="mr-2 text-xs uppercase tracking-widest opacity-70">
                          {issue.level === "error" ? "Mismatch" : "Check"}
                        </span>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {preview.chatContext.length > 0 ? (
                <div>
                  <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Chat around this file
                  </h3>
                  <div className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border/60 bg-card/40 p-3">
                    {preview.chatContext.map((message) => (
                      <p key={message.seq} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{message.sender ?? "Unknown"}</span>
                        {message.sent_at ? ` · ${new Date(message.sent_at).toLocaleString()}` : ""}
                        {message.body ? ` — ${message.body}` : ""}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}


              <div>
                <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Text read from the file</h3>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-card/40 p-3 text-xs text-foreground">
                  {preview.rawText?.trim() || "Nothing was read from this file."}
                </pre>
              </div>

              <div>
                <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Extracted fields</h3>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-card/40 p-3 text-xs text-foreground">
                  {preview.extracted ? JSON.stringify(preview.extracted, null, 2) : "No structured fields."}
                </pre>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}
