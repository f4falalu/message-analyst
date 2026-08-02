import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { applyMapping, type Mapping } from "@/lib/data-rules";

type MappingRow = Mapping & {
  id: string;
  notes: string | null;
  active: boolean;
};

export const Route = createFileRoute("/mappings")({
  head: () => ({
    meta: [
      { title: "Name mappings — Request Ledger" },
      {
        name: "description",
        content:
          "Configure facility name and item synonym rules so every WhatsApp import normalises extracted names the same way.",
      },
      { property: "og:title", content: "Name mappings — Request Ledger" },
      {
        property: "og:description",
        content: "Reusable facility and item synonym rules for consistent procurement records across imports.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MappingsPage,
});

function MappingsPage() {
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [kind, setKind] = useState<"facility" | "item">("facility");
  const [pattern, setPattern] = useState("");
  const [canonical, setCanonical] = useState("");
  const [notes, setNotes] = useState("");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [testValue, setTestValue] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("name_mappings")
      .select("id, kind, pattern, canonical, notes, active")
      .order("kind", { ascending: true })
      .order("pattern", { ascending: true })
      .limit(5000);
    if (error) {
      toast.error(error.message);
      return;
    }
    setRows((data ?? []) as MappingRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const trimmedPattern = pattern.trim();
    const trimmedCanonical = canonical.trim();
    if (!trimmedPattern || !trimmedCanonical) {
      toast.error("Both the written form and the standard name are needed.");
      return;
    }
    if (trimmedPattern.length > 120 || trimmedCanonical.length > 120) {
      toast.error("Keep names under 120 characters.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("name_mappings").insert({
      kind,
      pattern: trimmedPattern,
      canonical: trimmedCanonical,
      notes: notes.trim().slice(0, 300) || null,
    });
    setSaving(false);
    if (error) {
      toast.error(/duplicate/i.test(error.message) ? "That written form already has a rule." : error.message);
      return;
    }
    setPattern("");
    setCanonical("");
    setNotes("");
    void load();
  };

  const toggle = async (row: MappingRow) => {
    const { error } = await supabase.from("name_mappings").update({ active: !row.active }).eq("id", row.id);
    if (error) toast.error(error.message);
    else void load();
  };

  const remove = async (row: MappingRow) => {
    const { error } = await supabase.from("name_mappings").delete().eq("id", row.id);
    if (error) toast.error(error.message);
    else void load();
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      `${row.pattern} ${row.canonical} ${row.notes ?? ""}`.toLowerCase().includes(needle),
    );
  }, [rows, filter]);

  const activeMappings = useMemo(
    () => rows.filter((row) => row.active).map(({ kind: k, pattern: p, canonical: c }) => ({ kind: k, pattern: p, canonical: c })),
    [rows],
  );

  const testResult = testValue.trim() ? applyMapping(testValue, kind, activeMappings) : null;

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-5">
          <div>
            <Link to="/" className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
              Request Ledger
            </Link>
            <h1 className="font-serif text-2xl text-foreground">Name mappings</h1>
          </div>
          <Badge variant="secondary">{rows.filter((row) => row.active).length} active rules</Badge>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-8">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Rules here are applied every time a ledger is rebuilt, on this import and every future one. A rule
          matches when the written form equals the extracted name, or appears inside it as a whole phrase — so
          &ldquo;Kaloko HC&rdquo; and &ldquo;kaloko health centre&rdquo; can both fold into one standard name.
        </p>

        <div className="mt-6 grid gap-3 rounded-xl border border-border/60 bg-card/60 p-5 sm:grid-cols-[10rem_1fr_1fr_1fr_auto]">
          <Select value={kind} onValueChange={(value) => setKind(value as "facility" | "item")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="facility">Facility</SelectItem>
              <SelectItem value="item">Item</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="As written in documents"
            value={pattern}
            maxLength={120}
            onChange={(event) => setPattern(event.target.value)}
          />
          <Input
            placeholder="Standard name to store"
            value={canonical}
            maxLength={120}
            onChange={(event) => setCanonical(event.target.value)}
          />
          <Input
            placeholder="Note (optional)"
            value={notes}
            maxLength={300}
            onChange={(event) => setNotes(event.target.value)}
          />
          <Button onClick={add} disabled={saving}>
            {saving ? "Saving…" : "Add rule"}
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Input
            placeholder="Filter rules…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="max-w-xs"
          />
          <Input
            placeholder={`Try a ${kind} name…`}
            value={testValue}
            onChange={(event) => setTestValue(event.target.value)}
            className="max-w-xs"
          />
          {testResult ? (
            <span className="text-sm text-muted-foreground">
              becomes <span className="text-foreground">{testResult}</span>
            </span>
          ) : null}
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border border-border/60">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Kind</TableHead>
                <TableHead>As written</TableHead>
                <TableHead>Standard name</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                    No rules yet — add the spellings you keep seeing in the scans.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((row) => (
                  <TableRow key={row.id} className={row.active ? "" : "opacity-50"}>
                    <TableCell>
                      <Badge variant="outline">{row.kind}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{row.pattern}</TableCell>
                    <TableCell className="text-sm text-foreground">{row.canonical}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.notes ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => void toggle(row)}>
                        {row.active ? "Disable" : "Enable"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void remove(row)}>
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </main>
  );
}
