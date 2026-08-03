import { defineMcp } from "@lovable.dev/mcp-js";

type McpTools = Parameters<typeof defineMcp>[0]["tools"];
import listImports from "./tools/list-imports";
import searchRecords from "./tools/search-records";
import getRecord from "./tools/get-record";
import searchMessages from "./tools/search-messages";
import importSummary from "./tools/import-summary";

export default defineMcp({
  name: "chat-archive-hub",
  title: "Chat Archive Hub",
  version: "0.1.0",
  instructions:
    "Read-only tools over an archive of WhatsApp procurement chats. Start with `list_imports` to find an import id, then `search_records` for the extracted ledger (facility, items, amounts, dates, contacts), `get_record` to audit one record against its source messages and scanned documents, `search_messages` for raw transcript search, and `import_summary` for processing and data-quality status.",
  tools: [listImports, searchRecords, getRecord, searchMessages, importSummary] as unknown as McpTools,
});
