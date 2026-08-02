import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  finishProcessingRun,
  processAttachmentBatch,
  rebuildRecords,
  retryFailedAttachments,
  startProcessingRun,
  getAttachmentPreview,
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

type Counts = { pending: number; done: number; error: number; skipped: number };

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

  const [importName, setImportName] = useState("");
  const [counts, setCounts] = useState<Counts>({ pending: 0, done: 0, error: 0, skipped: 0 });
  const [records, setRecords] = useState<RequestRecord[]>([]);
  const [reading, setReading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [concurrency, setConcurrency] = useState("4");
  const [chunkSize, setChunkSize] = useState("6");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventFilter, setEventFilter] = useState("all");

  const [messageQuery, setMessageQuery] = useState("");
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [searching, setSearching] = useState(false);

  const loadCounts = useCallback(async () => {
    const statuses: (keyof Counts)[] = ["pending", "done", "error", "skipped"];
    const next: Counts = { pending: 0, done: 0, error: 0, skipped: 0 };
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

  const readAll = async () => {
    setReading(true);
    const lanes = Number(concurrency);
    const chunk = Number(chunkSize);
    let runId: string | null = null;
    let stopped = false;
    let stopReason: string | null = null;
    try {
      const started = await beginRun({ data: { importId, concurrency: lanes, chunkSize: chunk } });
      runId = started.runId;
      setActiveRunId(runId);
      await loadRuns();

      // Each lane pulls its own chunk of files; the backend hands out
      // non-overlapping batches, so lanes never read the same document.
      const lane = async () => {
        for (;;) {
          if (stopped) return;
          const result = await runBatch({ data: { importId, limit: chunk, runId } });
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
          if (result.processed === 0 && result.failed === 0) return;
        }
      };

      await Promise.all(Array.from({ length: lanes }, () => lane()));
      await endRun({ data: { runId, status: stopped ? "stopped" : "completed", notes: stopReason } });
      if (!stopped) toast.success("Reading finished.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reading stopped unexpectedly.";
      toast.error(message);
      if (runId) await endRun({ data: { runId, status: "error", notes: message } });
    } finally {
      setReading(false);
      void loadCounts();
      void loadRuns();
      void loadEvents(runId ?? activeRunId);
    }
  };


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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => {
      if (statusFilter === "review" && !record.needs_review) return false;
      if (statusFilter === "paid" && record.status !== "paid") return false;
      if (statusFilter === "unpaid" && record.payment_date) return false;
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
  }, [records, query, statusFilter]);

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
                {counts.error.toLocaleString()} failed · {counts.skipped.toLocaleString()} not readable
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
                    {["2", "4", "6", "8", "12"].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={readAll} disabled={reading || counts.pending === 0}>
                {reading ? "Reading…" : "Read pending documents"}
              </Button>
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
          <Progress className="mt-5" value={readPercent} />
          <p className="mt-2 text-xs text-muted-foreground">
            {concurrency} lanes × {chunkSize} files per chunk — up to{" "}
            {Number(concurrency) * Number(chunkSize)} documents read at once.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-20">
        <Tabs defaultValue="records">
          <TabsList>
            <TabsTrigger value="records">Ledger</TabsTrigger>
            <TabsTrigger value="messages">Conversation</TabsTrigger>
            <TabsTrigger value="log">Run log</TabsTrigger>
          </TabsList>


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
              <span className="text-sm text-muted-foreground">
                {filtered.length.toLocaleString()} records · {formatMoney(totalPaid, filtered[0]?.currency ?? null)} recorded
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                        No log entries yet — run the reader to record one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleEvents.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="max-w-[18rem] truncate font-mono text-xs">{event.filename}</TableCell>
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
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>

      </section>
    </main>
  );
}
