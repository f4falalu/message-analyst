// Which upstream URLs the public relay route is willing to call.
//
// This is a server-side request forgery (SSRF) boundary, not a convenience
// filter. `/api/public/local-model-relay` is unauthenticated, so the `target`
// parameter is attacker-controlled: anything these two patterns admit is
// something an anonymous caller can make our server fetch on their behalf.
// Widen them only with that in mind.
//
// Kept apart from the route handler so the policy can be tested directly,
// without standing up a request.

const ALLOWED_HOST = /\.ngrok-free\.(app|dev)$/i;

// `show` is how Ollama reports a model's capabilities (vision or not). It is a
// metadata read on a host that is already allow-listed, and without it the
// capability probe silently degrades to guessing from the model's name.
const ALLOWED_PATH = /^\/(v1\/(models|chat\/completions)|api\/(tags|pull|show))$/;

/**
 * Turn the raw `target` query parameter into a URL we are willing to call, or
 * null to reject. Rejects anything that is not https, not an ngrok tunnel host,
 * or not one of the specific model-API paths above.
 */
export function relayTargetFrom(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== "https:") return null;
  if (!ALLOWED_HOST.test(target.hostname)) return null;
  if (!ALLOWED_PATH.test(target.pathname)) return null;
  return target;
}
