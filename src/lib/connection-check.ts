// Two-hop diagnostics for a model running on the user's own computer.
//
// A local run has two independent hops, and they fail for different reasons:
//   browser → tunnel   blocked by Ollama's origin policy (403) or CORS
//   tunnel  → Ollama   blocked when Ollama is down, bound to loopback only,
//                      or the tunnel session has expired
// Testing them separately is what makes the fix obvious: the server-side relay
// carries no browser origin, so it isolates the tunnel from the CORS question.

export type HopStatus = "ok" | "blocked" | "unreachable";

export type HopResult = {
  id: "browser-tunnel" | "tunnel-ollama";
  label: string;
  status: HopStatus;
  httpStatus: number | null;
  detail: string;
  hint: string;
  /** Models the hop managed to list, when it got that far. */
  models: string[];
};

export type ConnectionReport = {
  ranAt: number;
  baseUrl: string;
  origin: string;
  hops: HopResult[];
  ok: boolean;
  summary: string;
};

const trim = (url: string) => url.replace(/\/+$/, "");

export function isTunnelUrl(baseUrl: string): boolean {
  try {
    return /\.ngrok-free\.(app|dev)$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function appOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function modelsFrom(payload: unknown): string[] {
  const data = (payload as { data?: { id?: string }[]; models?: { name?: string }[] } | null) ?? {};
  const ids = [
    ...(data.data ?? []).map((entry) => entry.id),
    ...(data.models ?? []).map((entry) => entry.name),
  ].filter((id): id is string => Boolean(id));
  return Array.from(new Set(ids));
}

/** Hop 1: this tab talks straight to the tunnel — the hop a real run uses. */
async function checkBrowserHop(baseUrl: string): Promise<HopResult> {
  const url = `${trim(baseUrl)}/models`;
  const base: Omit<HopResult, "status" | "detail" | "hint"> = {
    id: "browser-tunnel",
    label: "This browser → tunnel",
    httpStatus: null,
    models: [],
  };
  try {
    const response = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      return {
        ...base,
        httpStatus: response.status,
        status: "blocked",
        detail: `${response.status} — the tunnel answered with an HTML warning page instead of the model API.`,
        hint: "Restart the tunnel with --host-header=localhost:11434 so requests reach Ollama directly.",
      };
    }
    if (response.status === 403) {
      return {
        ...base,
        httpStatus: 403,
        status: "blocked",
        detail: "403 — Ollama refused this page's origin.",
        hint: `Set OLLAMA_ORIGINS to include ${appOrigin() || "this app's address"} (or *) and restart Ollama, then restart the tunnel.`,
      };
    }
    if (!response.ok) {
      return {
        ...base,
        httpStatus: response.status,
        status: "blocked",
        detail: `${response.status} — the tunnel answered, but not with a model list.`,
        hint: "Check the base URL ends with /v1 and points at port 11434.",
      };
    }
    const models = modelsFrom(await response.json());
    return {
      ...base,
      httpStatus: 200,
      models,
      status: "ok",
      detail: `200 — direct connection works, ${models.length} model${models.length === 1 ? "" : "s"} listed.`,
      hint: "",
    };
  } catch (error) {
    const mixed =
      typeof window !== "undefined" &&
      window.location.protocol === "https:" &&
      /^http:\/\//i.test(baseUrl.trim());
    return {
      ...base,
      status: "unreachable",
      detail: `No response — ${error instanceof Error ? error.message : "connection refused"}.`,
      hint: mixed
        ? "This page is https and the endpoint is plain http; browsers block that. Put Ollama behind an https tunnel and paste that URL."
        : `The browser was blocked before any status came back — this is almost always CORS. Start Ollama with OLLAMA_ORIGINS=${appOrigin() || "*"} and restart it.`,
    };
  }
}

/** Hop 2: the server relay talks to the tunnel — no browser origin involved. */
async function checkRelayHop(baseUrl: string): Promise<HopResult> {
  const target = `${trim(baseUrl)}/models`;
  const base: Omit<HopResult, "status" | "detail" | "hint"> = {
    id: "tunnel-ollama",
    label: "Tunnel → Ollama",
    httpStatus: null,
    models: [],
  };
  if (!isTunnelUrl(baseUrl)) {
    return {
      ...base,
      status: "ok",
      detail: "Skipped — this address is not a tunnel, so only the direct check applies.",
      hint: "",
    };
  }
  try {
    const response = await fetch(`/api/public/local-model-relay?target=${encodeURIComponent(target)}`);
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const models = modelsFrom(payload);
      return {
        ...base,
        httpStatus: 200,
        models,
        status: "ok",
        detail: `200 — the tunnel reaches Ollama, ${models.length} model${models.length === 1 ? "" : "s"} listed.`,
        hint: "",
      };
    }
    const detail = (payload as { error?: string } | null)?.error ?? "no detail";
    return {
      ...base,
      httpStatus: response.status,
      status: response.status === 403 ? "blocked" : "unreachable",
      detail: `${response.status} — ${detail}`,
      hint:
        response.status === 403
          ? "The tunnel rejected the request. Restart ngrok without an interstitial/auth policy."
          : "Ollama looks down or is not on port 11434. Run OLLAMA_HOST=0.0.0.0:11434 ollama serve, then restart the tunnel.",
    };
  } catch (error) {
    return {
      ...base,
      status: "unreachable",
      detail: `No response — ${error instanceof Error ? error.message : "the relay did not answer"}.`,
      hint: "Check the tunnel terminal is still open; free tunnels expire when the window closes.",
    };
  }
}

/** Run both hops and turn the pair into one plain-language verdict. */
export async function runConnectionCheck(baseUrl: string): Promise<ConnectionReport> {
  const [browserHop, relayHop] = await Promise.all([checkBrowserHop(baseUrl), checkRelayHop(baseUrl)]);
  const hops = [browserHop, relayHop];
  const ok = browserHop.status === "ok";

  let summary: string;
  if (ok) summary = "Ready — this page can read documents with the model on your computer.";
  else if (relayHop.status === "ok")
    summary =
      "The tunnel reaches Ollama, but this page is refused. That is an origin (CORS) setting on Ollama, not the tunnel.";
  else if (browserHop.status === "unreachable" && relayHop.status === "unreachable")
    summary = "Nothing answered on either path. Ollama or the tunnel is not running.";
  else summary = "The connection is only partly working — follow the hint on the failing hop.";

  return { ranAt: Date.now(), baseUrl: trim(baseUrl), origin: appOrigin(), hops, ok, summary };
}
