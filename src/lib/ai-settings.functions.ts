import { createServerFn } from "@tanstack/react-start";
import type { ProviderConfig } from "./ai-provider.server";

export type ProviderSummary = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  fallbackModels: string[];
  authStyle: string;
  supportsPdf: boolean;
  isActive: boolean;
  hasKey: boolean;
  keyPreview: string;
  notes: string | null;
  updatedAt: string;
};

function mask(key: string | null): string {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export const listAiProviders = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabase
    .from("ai_providers")
    .select("id, label, base_url, model, fallback_models, api_key, auth_style, supports_pdf, is_active, notes, updated_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const providers: ProviderSummary[] = (data ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    model: row.model,
    fallbackModels: row.fallback_models ?? [],
    authStyle: row.auth_style,
    supportsPdf: row.supports_pdf,
    isActive: row.is_active,
    hasKey: Boolean(row.api_key),
    keyPreview: mask(row.api_key),
    notes: row.notes,
    updatedAt: row.updated_at,
  }));

  return {
    providers,
    lovableAvailable: Boolean(process.env["LOVABLE_API_KEY"]),
    usingLovable: !providers.some((p) => p.isActive),
  };
});

export const saveAiProvider = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      id?: string | null;
      label: string;
      baseUrl: string;
      model: string;
      fallbackModels?: string[] | null;
      apiKey?: string | null;
      authStyle: string;
      supportsPdf: boolean;
      notes?: string | null;
    }) => ({
      id: input.id ? String(input.id) : null,
      label: String(input.label).trim().slice(0, 120),
      baseUrl: String(input.baseUrl).trim().replace(/\/+$/, "").slice(0, 300),
      model: String(input.model).trim().slice(0, 200),
      fallbackModels: (Array.isArray(input.fallbackModels) ? input.fallbackModels : [])
        .map((m) => String(m).trim().slice(0, 200))
        .filter((m) => m.length > 0)
        .slice(0, 8),
      apiKey: input.apiKey ? String(input.apiKey).trim() : null,
      authStyle: ["bearer", "x-api-key", "none", "lovable"].includes(String(input.authStyle))
        ? String(input.authStyle)
        : "bearer",
      supportsPdf: Boolean(input.supportsPdf),
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
    }),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    if (!data.label || !data.baseUrl || !data.model) {
      throw new Error("Give the model a name, a base URL and a model id.");
    }
    if (!/^https?:\/\/[^\s]+$/i.test(data.baseUrl)) {
      throw new Error(
        `"${data.baseUrl}" is not a valid base URL. It must start with https:// — e.g. https://openrouter.ai/api/v1`,
      );
    }

    if (data.id) {
      const patch: {
        label: string;
        base_url: string;
        model: string;
        fallback_models: string[];
        auth_style: string;
        supports_pdf: boolean;
        notes: string | null;
        api_key?: string;
      } = {
        label: data.label,
        base_url: data.baseUrl,
        model: data.model,
        fallback_models: data.fallbackModels,
        auth_style: data.authStyle,
        supports_pdf: data.supportsPdf,
        notes: data.notes,
      };
      // An empty key field means "keep the saved key".
      if (data.apiKey) patch.api_key = data.apiKey;
      const { error } = await supabase.from("ai_providers").update(patch).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }

    const { data: row, error } = await supabase
      .from("ai_providers")
      .insert({
        label: data.label,
        base_url: data.baseUrl,
        model: data.model,
        fallback_models: data.fallbackModels,
        api_key: data.apiKey,
        auth_style: data.authStyle,
        supports_pdf: data.supportsPdf,
        notes: data.notes,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "Could not save that model.");
    return { id: row.id };
  });

export const activateAiProvider = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string | null }) => ({ id: input.id ? String(input.id) : null }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    // Clear first: only one provider may be active at a time.
    const { error: clearError } = await supabase
      .from("ai_providers")
      .update({ is_active: false })
      .eq("is_active", true);
    if (clearError) throw new Error(clearError.message);

    if (data.id) {
      const { error } = await supabase
        .from("ai_providers")
        .update({ is_active: true })
        .eq("id", data.id);
      if (error) throw new Error(error.message);
    }
    return { active: data.id };
  });

export const deleteAiProvider = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => ({ id: String(input.id) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const { error } = await supabase.from("ai_providers").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { deleted: true };
  });

export const testAiProvider = createServerFn({ method: "POST" })
  .inputValidator((input: { id?: string | null }) => ({ id: input.id ? String(input.id) : null }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const { lovableProvider, providerHeaders, modelList } = await import("./ai-provider.server");

    let provider: ProviderConfig;
    if (data.id) {
      const { data: row, error } = await supabase
        .from("ai_providers")
        .select("id, label, base_url, model, fallback_models, api_key, auth_style, supports_pdf")
        .eq("id", data.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) throw new Error("That model is no longer saved.");
      provider = {
        id: row.id,
        label: row.label,
        baseUrl: row.base_url.replace(/\/+$/, ""),
        model: row.model,
        models: modelList(row.model, row.fallback_models),
        apiKey: row.api_key ?? "",
        authStyle: row.auth_style as ProviderConfig["authStyle"],
        supportsPdf: row.supports_pdf,
      };
    } else {
      const key = process.env["LOVABLE_API_KEY"];
      if (!key) throw new Error("Lovable AI is not available on this project.");
      provider = lovableProvider(key);
    }

    if (!/^https?:\/\/[^\s]+$/i.test(provider.baseUrl)) {
      throw new Error(
        `The saved base URL ("${provider.baseUrl}") is not a web address. Edit this model and set it to your provider's endpoint, e.g. https://openrouter.ai/api/v1`,
      );
    }
    if (provider.authStyle !== "none" && !provider.apiKey) {
      throw new Error("No API key is saved for this model. Edit it and paste your key.");
    }

    const started = Date.now();
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(provider),
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: "Reply with the single word: ready" }],
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        return { ok: false, ms: Date.now() - started, detail: `${res.status}: ${body.slice(0, 400)}` };
      }
      let reply = "";
      try {
        const parsed = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
        reply = parsed.choices?.[0]?.message?.content ?? "";
      } catch {
        reply = body.slice(0, 200);
      }
      return { ok: true, ms: Date.now() - started, detail: reply.slice(0, 200) || "Empty reply" };
    } catch (error) {
      return {
        ok: false,
        ms: Date.now() - started,
        detail: error instanceof Error ? error.message : "Could not reach that endpoint.",
      };
    }
  });
