import { defineMcp, auth } from "@lovable.dev/mcp-js";

type McpTools = Parameters<typeof defineMcp>[0]["tools"];
import listImports from "./tools/list-imports";
import searchRecords from "./tools/search-records";
import getRecord from "./tools/get-record";
import searchMessages from "./tools/search-messages";
import importSummary from "./tools/import-summary";

type RuntimeGlobals = typeof globalThis & {
  Deno?: { env?: { get?: (name: string) => string | undefined } };
  process?: { env?: Record<string, string | undefined> };
};

function env(name: string): string | undefined {
  const runtime = globalThis as RuntimeGlobals;
  return runtime.Deno?.env?.get?.(name) ?? runtime.process?.env?.[name];
}

const supabaseUrl = (env("SUPABASE_URL") ?? env("VITE_SUPABASE_URL") ?? "").replace(/\/+$/, "");

export default defineMcp({
  name: "chat-archive-hub",
  title: "Chat Archive Hub",
  version: "0.1.0",
  // Require a verified Supabase-issued access token on every MCP request.
  auth: auth.oauth.issuer({
    issuer: `${supabaseUrl}/auth/v1`,
    acceptedAudiences: "authenticated",
    resourceName: "Chat Archive Hub",
  }),
  instructions:
    "Read-only tools over an archive of WhatsApp procurement chats. Start with `list_imports` to find an import id, then `search_records` for the extracted ledger (facility, items, amounts, dates, contacts), `get_record` to audit one record against its source messages and scanned documents, `search_messages` for raw transcript search, and `import_summary` for processing and data-quality status.",
  tools: [listImports, searchRecords, getRecord, searchMessages, importSummary] as unknown as McpTools,
});

