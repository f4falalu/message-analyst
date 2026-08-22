import { createFileRoute } from "@tanstack/react-router";

const ALLOWED_HOST = /\.ngrok-free\.(app|dev)$/i;
const ALLOWED_PATH = /^\/(v1\/(models|chat\/completions)|api\/(tags|pull))$/;

function targetFrom(request: Request): URL | null {
  const raw = new URL(request.url).searchParams.get("target");
  if (!raw) return null;
  try {
    const target = new URL(raw);
    if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname) || !ALLOWED_PATH.test(target.pathname)) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

async function relay(request: Request): Promise<Response> {
  const target = targetFrom(request);
  if (!target) return Response.json({ error: "Unsupported local model endpoint." }, { status: 400 });

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  headers.set("ngrok-skip-browser-warning", "true");

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "error",
    });
    const responseHeaders = new Headers();
    responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The tunnel did not respond." },
      { status: 502 },
    );
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