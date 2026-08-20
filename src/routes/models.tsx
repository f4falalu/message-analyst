import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDER_PRESETS } from "@/lib/ai-models";
import {
  activateAiProvider,
  deleteAiProvider,
  listAiProviders,
  saveAiProvider,
  testAiProvider,
  type ProviderSummary,
} from "@/lib/ai-settings.functions";

export const Route = createFileRoute("/models")({
  head: () => ({
    meta: [
      { title: "AI models & keys — Request Ledger" },
      {
        name: "description",
        content:
          "Bring your own key: point document reading at OpenRouter, Mistral, DeepSeek, Qwen, GLM, Groq or a local model instead of built-in credits.",
      },
      { property: "og:title", content: "AI models & keys — Request Ledger" },
      {
        property: "og:description",
        content: "Configure any OpenAI-compatible model for reading scanned procurement documents.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ModelsPage,
});

const emptyForm = {
  id: null as string | null,
  presetId: "openrouter",
  label: "",
  baseUrl: "",
  model: "",
  fallbackModels: "",
  apiKey: "",
  authStyle: "bearer",
  supportsPdf: true,
  notes: "",
};

function ModelsPage() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [lovableAvailable, setLovableAvailable] = useState(true);
  const [usingLovable, setUsingLovable] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string; ms: number }>>({});

  const preset = useMemo(
    () => PROVIDER_PRESETS.find((p) => p.id === form.presetId) ?? PROVIDER_PRESETS[0]!,
    [form.presetId],
  );

  const load = useCallback(async () => {
    try {
      const result = await listAiProviders();
      setProviders(result.providers);
      setLovableAvailable(result.lovableAvailable);
      setUsingLovable(result.usingLovable);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load your models.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choosePreset = (presetId: string) => {
    const next = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!next) return;
    setForm((current) => ({
      ...current,
      presetId,
      label: current.id ? current.label : next.label.split(" (")[0] ?? next.label,
      baseUrl: next.baseUrl,
      authStyle: next.authStyle,
      supportsPdf: next.supportsPdf,
      model: next.models[0]?.id ?? "",
      fallbackModels: current.id
        ? current.fallbackModels
        : next.models.slice(1, 5).map((m) => m.id).join("\n"),
    }));
  };

  const edit = (provider: ProviderSummary) => {
    const matched =
      PROVIDER_PRESETS.find((p) => p.baseUrl && provider.baseUrl.startsWith(p.baseUrl))?.id ?? "custom";
    setForm({
      id: provider.id,
      presetId: matched,
      label: provider.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      fallbackModels: (provider.fallbackModels ?? []).join("\n"),
      apiKey: "",
      authStyle: provider.authStyle,
      supportsPdf: provider.supportsPdf,
      notes: provider.notes ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveAiProvider({
        data: {
          id: form.id,
          label: form.label,
          baseUrl: form.baseUrl,
          model: form.model,
          fallbackModels: form.fallbackModels
            .split(/[\n,]/)
            .map((m) => m.trim())
            .filter(Boolean),
          apiKey: form.apiKey || null,
          authStyle: form.authStyle,
          supportsPdf: form.supportsPdf,
          notes: form.notes || null,
        },
      });
      toast.success(form.id ? "Model updated." : "Model saved.");
      setForm(emptyForm);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that model.");
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id: string | null) => {
    setBusy(true);
    try {
      await activateAiProvider({ data: { id } });
      toast.success(id ? "Document reading now uses that model." : "Back to built-in Lovable AI.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not switch model.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await deleteAiProvider({ data: { id } });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that model.");
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string | null) => {
    const key = id ?? "lovable";
    setTesting(key);
    try {
      const result = await testAiProvider({ data: { id } });
      setResults((current) => ({ ...current, [key]: result }));
      if (result.ok) toast.success(`Replied in ${result.ms} ms`);
      else toast.error(result.detail || "The endpoint rejected the test call.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Test failed.");
    } finally {
      setTesting(null);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Link to="/" className="font-serif text-xl tracking-tight text-foreground">
            Request Ledger
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/mappings" className="text-sm text-muted-foreground hover:text-foreground">
              Name mappings
            </Link>
            <span className="text-sm text-foreground">AI models</span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="font-serif text-3xl tracking-tight text-foreground">AI models & keys</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Reading thousands of scans is the expensive part. Point it at your own account instead — any
          OpenAI-compatible endpoint works, including OpenRouter, Mistral, DeepSeek, Qwen, GLM, Groq,
          Together, Fireworks or a model running on your own machine. Keys are stored server-side and never
          sent to the browser.
        </p>

        <div className="mt-8 rounded-lg border border-border/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                Built-in Lovable AI {usingLovable ? <Badge className="ml-2">In use</Badge> : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {lovableAvailable
                  ? "Gemini via workspace credits — no key needed, but it draws down credits on every page read."
                  : "Not available on this project."}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!lovableAvailable || testing === "lovable"}
                onClick={() => void test(null)}
              >
                {testing === "lovable" ? "Testing…" : "Test"}
              </Button>
              <Button size="sm" disabled={usingLovable || busy} onClick={() => void activate(null)}>
                Use this
              </Button>
            </div>
          </div>
          {results["lovable"] ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {results["lovable"]!.ok ? "OK · " : "Failed · "}
              {results["lovable"]!.detail}
            </p>
          ) : null}
        </div>

        <div className="mt-6 rounded-lg border border-border/60 p-5">
          <h2 className="text-sm font-medium text-foreground">
            {form.id ? "Edit model" : "Add your own model"}
          </h2>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={form.presetId} onValueChange={choosePreset}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Get a key from {preset.keyHint}</p>
            </div>

            <div className="space-y-1.5">
              <Label>Name for this setup</Label>
              <Input
                value={form.label}
                placeholder="e.g. OpenRouter — Qwen VL"
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Just a nickname for you (this is where a key name like "Buddy" goes).
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Base URL</Label>
              <Input
                value={form.baseUrl}
                placeholder="https://openrouter.ai/api/v1"
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                The provider's endpoint address — not your key or its name.
              </p>
            </div>


            <div className="space-y-1.5">
              <Label>Model</Label>
              {preset.models.length > 0 ? (
                <Select value={form.model} onValueChange={(value) => setForm({ ...form, model: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {preset.models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                        {m.note ? ` · ${m.note}` : ""}
                      </SelectItem>
                    ))}
                    {form.model && !preset.models.some((m) => m.id === form.model) ? (
                      <SelectItem value={form.model}>{form.model}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              ) : null}
              <Input
                value={form.model}
                placeholder="exact model id from your provider"
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label>Backup models (bounce here when rate limited)</Label>
              <textarea
                className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
                value={form.fallbackModels}
                placeholder={"one model id per line\ne.g. qwen/qwen2.5-vl-72b-instruct"}
                onChange={(e) => setForm({ ...form, fallbackModels: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                When the main model hits a rate limit, the next id in this list reads that file straight
                away and the tired model is rested for a minute. Up to 8 ids, tried in order.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>API key {form.id ? "(leave blank to keep the saved key)" : ""}</Label>
              <Input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                placeholder={form.authStyle === "none" ? "not needed" : "sk-…"}
                disabled={form.authStyle === "none"}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Authentication header</Label>
              <Select
                value={form.authStyle}
                onValueChange={(value) => setForm({ ...form, authStyle: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">Authorization: Bearer (most providers)</SelectItem>
                  <SelectItem value="x-api-key">x-api-key</SelectItem>
                  <SelectItem value="none">No key (local model)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3 md:col-span-2">
              <Switch
                checked={form.supportsPdf}
                onCheckedChange={(checked) => setForm({ ...form, supportsPdf: checked })}
              />
              <div>
                <p className="text-sm text-foreground">This model can read PDFs directly</p>
                <p className="text-xs text-muted-foreground">
                  Leave off for image-only models — PDFs are then held back instead of failing, so nothing
                  goes missing from the ledger.
                </p>
              </div>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label>Notes</Label>
              <Input
                value={form.notes}
                placeholder="optional — pricing, rate limits, who owns the key"
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <Button disabled={busy} onClick={() => void save()}>
              {form.id ? "Save changes" : "Add model"}
            </Button>
            {form.id ? (
              <Button variant="ghost" onClick={() => setForm(emptyForm)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-8 space-y-3">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom models saved yet.</p>
          ) : null}
          {providers.map((provider) => (
            <div key={provider.id} className="rounded-lg border border-border/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {provider.label}
                    {provider.isActive ? <Badge className="ml-2">In use</Badge> : null}
                    {!provider.supportsPdf ? (
                      <Badge variant="outline" className="ml-2">
                        Images only
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {provider.model} · {provider.baseUrl}
                  </p>
                  {provider.fallbackModels?.length ? (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      backups: {provider.fallbackModels.join(", ")}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Key {provider.hasKey ? provider.keyPreview : "not set"}
                    {provider.notes ? ` · ${provider.notes}` : ""}
                  </p>
                  {results[provider.id] ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {results[provider.id]!.ok ? "OK · " : "Failed · "}
                      {results[provider.id]!.detail}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testing === provider.id}
                    onClick={() => void test(provider.id)}
                  >
                    {testing === provider.id ? "Testing…" : "Test"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => edit(provider)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    disabled={provider.isActive || busy}
                    onClick={() => void activate(provider.id)}
                  >
                    Use this
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(provider.id)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
