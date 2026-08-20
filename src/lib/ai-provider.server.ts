// Server-only: resolves which AI endpoint reads the documents.
//
// Default is Lovable AI (no key needed). If a bring-your-own-key provider is
// marked active in `ai_providers`, that one is used instead — any
// OpenAI-compatible chat endpoint works (OpenRouter, Mistral, DeepSeek,
// Together, Groq, Fireworks, a local Ollama/vLLM, …).

export type ProviderConfig = {
  id: string | null;
  label: string;
  baseUrl: string;
  model: string;
  /** Ordered read list: the primary model first, then any backups. */
  models: string[];
  apiKey: string;
  authStyle: "bearer" | "lovable" | "x-api-key" | "none";
  supportsPdf: boolean;
};

/**
 * A model that just hit a rate limit is parked for a while so other files in
 * the same run skip it instead of hammering it. In-memory and per-worker on
 * purpose — it is a hint, never a source of truth.
 */
const COOLDOWN_MS = 60_000;
const cooldowns = new Map<string, number>();

export function markModelCooling(model: string, ms = COOLDOWN_MS): void {
  cooldowns.set(model, Date.now() + ms);
}

export function isModelCooling(model: string): boolean {
  const until = cooldowns.get(model);
  if (!until) return false;
  if (until <= Date.now()) {
    cooldowns.delete(model);
    return false;
  }
  return true;
}

/** Primary first, then backups, deduped and cleaned. */
export function modelList(primary: string, fallbacks: unknown): string[] {
  const extra = Array.isArray(fallbacks) ? fallbacks : [];
  const all = [primary, ...extra]
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m.length > 0);
  return Array.from(new Set(all));
}

export const LOVABLE_BASE_URL = "https://ai.gateway.lovable.dev/v1";
export const LOVABLE_DEFAULT_MODEL = "google/gemini-3.6-flash";

export function lovableProvider(apiKey: string): ProviderConfig {
  return {
    id: null,
    label: "Lovable AI (credits)",
    baseUrl: LOVABLE_BASE_URL,
    model: LOVABLE_DEFAULT_MODEL,
    models: [LOVABLE_DEFAULT_MODEL],
    apiKey,
    authStyle: "lovable",
    supportsPdf: true,
  };
}

type Row = {
  id: string;
  label: string;
  base_url: string;
  model: string;
  fallback_models?: string[] | null;
  api_key: string | null;
  auth_style: string;
  supports_pdf: boolean;
};

function fromRow(row: Row): ProviderConfig {
  const style = row.auth_style;
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url.replace(/\/+$/, ""),
    model: row.model,
    models: modelList(row.model, row.fallback_models),
    apiKey: row.api_key ?? "",
    authStyle:
      style === "lovable" || style === "x-api-key" || style === "none" ? style : "bearer",
    supportsPdf: row.supports_pdf,
  };
}

/** The provider the next document read should use. */
export async function resolveAiProvider(supabase: {
  from: (table: "ai_providers") => {
    select: (cols: string) => {
      eq: (
        col: string,
        value: boolean,
      ) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
    };
  };
}): Promise<ProviderConfig> {
  const { data } = await supabase
    .from("ai_providers")
    .select("id, label, base_url, model, fallback_models, api_key, auth_style, supports_pdf")
    .eq("is_active", true)
    .maybeSingle();

  if (data) {
    const config = fromRow(data as Row);
    if (config.authStyle === "none" || config.apiKey) return config;
  }

  const key = process.env["LOVABLE_API_KEY"];
  if (!key) {
    throw new Error(
      "No AI model is configured. Add your own model key under Models, or enable Lovable AI.",
    );
  }
  return lovableProvider(key);
}

export function providerHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.authStyle === "lovable") headers["Lovable-API-Key"] = provider.apiKey;
  else if (provider.authStyle === "bearer") headers["Authorization"] = `Bearer ${provider.apiKey}`;
  else if (provider.authStyle === "x-api-key") headers["x-api-key"] = provider.apiKey;
  if (provider.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://lovable.dev";
    headers["X-Title"] = "Request Ledger";
  }
  return headers;
}
