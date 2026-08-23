import { createFileRoute } from "@tanstack/react-router";
import { relayTargetFrom } from "@/lib/relay-target";

// Keep this below the ingress proxy's practical request ceiling. Browser-side
// rasterisation targets a substantially smaller payload before calling us.
// Requests larger than the public ingress allowance never reach this route and
// surface as an HTML 502. Keep our explicit guard below that hard boundary so
// callers receive a useful JSON 413 if compression ever regresses.
const MAX_RELAY_BODY_BYTES = 700 * 1024;

function targetFrom(request: Request): URL | null {
  return relayTargetFrom(new URL(request.url).searchParams.get("target"));
}

async function relay(request: Request): Promise<Response> {
  const target = targetFrom(request);
  if (!target) return Response.json({ error: "Unsupported local model endpoint." }, { status: 400 });

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RELAY_BODY_BYTES) {
    return Response.json(
      { error: "The rendered document is too large to relay. Try a smaller file or fewer PDF pages." },
      { status: 413 },
    );
  }

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  headers.set("ngrok-skip-browser-warning", "true");

  const isBodyless = request.method === "GET" || request.method === "HEAD";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  try {
    // Do not pipe request.body into another fetch. The edge runtime can terminate
    // that stream while the upstream fetch still owns it, which surfaces as an
    // infrastructure 502 before this handler can return an error response.
    // A bounded byte buffer is deterministic and remains well below memory limits.
    const body = isBodyless ? null : await request.arrayBuffer();
    if (body && body.byteLength > MAX_RELAY_BODY_BYTES) {
      return Response.json(
        { error: "The rendered document is too large to relay. Try a smaller file or fewer PDF pages." },
        { status: 413 },
      );
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return Response.json(
        { error: "The tunnel redirected the request instead of answering. Point it straight at Ollama (port 11434)." },
        { status: 502 },
      );
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const code = upstream.headers.get("ngrok-error-code");
      const detail = code === "ERR_NGROK_3200"
        ? "The ngrok tunnel is offline. Keep its terminal window open and start it again."
        : `ngrok returned its browser page instead of Ollama${code ? ` (${code})` : ""}.`;
      return Response.json({ error: detail }, { status: 502 });
    }
    const responseHeaders = new Headers();
    responseHeaders.set("content-type", contentType || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const message = controller.signal.aborted
      ? "This computer took too long to answer (over 5 minutes). Try a smaller model or fewer files at a time."
      : error instanceof Error
        ? `Could not reach the tunnel: ${error.message}`
        : "The tunnel did not respond.";
    return Response.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

}

export const Route = createFileRoute("/api/public/local-model-relay")({
  server: {
    handlers: {
      GET: ({ request }) => relay(request),
      POST: ({ request }) => relay(request),
    },
  },
});