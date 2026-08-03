import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ingestZip, type IngestProgress } from "@/lib/ingest";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type ImportRow = {
  id: string;
  filename: string;
  status: string;
  message_count: number;
  total_files: number;
  created_at: string;
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
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    supabase
      .from("imports")
      .select("id, filename, status, message_count, total_files, created_at")
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
      });
  }, [busy]);

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("Please choose the WhatsApp .zip export.");
      return;
    }
    setBusy(true);
    setPaused(false);
    pausedRef.current = false;
    cancelledRef.current = false;
    const importId = resumeId;
    try {
      const result = await ingestZip(file, setProgress, {
        ...(importId ? { resumeImportId: importId } : {}),
        control: { isPaused: () => pausedRef.current, isCancelled: () => cancelledRef.current },
      });
      if (result.cancelled) {
        toast.info(
          `Upload stopped — ${(result.attachments + result.skipped).toLocaleString()} file(s) are saved. Resume with the same zip to finish.`,
        );
      } else if (result.failed.length > 0) {
        toast.warning(
          `${result.attachments.toLocaleString()} files uploaded, ${result.failed.length.toLocaleString()} failed — press “Resume upload” with the same zip to retry just those.`,
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
      setResumeId(null);
    }
  };



  const percent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;

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
                  <p className="text-sm text-foreground">{progress?.message ?? "Working…"}</p>
                  <Progress value={percent ?? undefined} />
                  <p className="text-xs text-muted-foreground">
                    Keep this tab open — the zip is unpacked here in your browser and streamed up file by file.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
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

                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link to="/archive/$importId" params={{ importId: row.id }}>
                        Open archive
                      </Link>
                    </Button>
                    {row.status !== "ready" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setResumeId(row.id);
                          inputRef.current?.click();
                        }}
                      >
                        Resume upload
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
