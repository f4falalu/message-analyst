import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon, text } from "../supabase";

export default defineTool({
  name: "list_imports",
  title: "List archive imports",
  description:
    "List WhatsApp chat exports (imports) held in the archive, with their status, message count and file count. Use the returned id as import_id for other tools.",
  inputSchema: { limit: z.number().int().min(1).max(50).default(20).describe("How many imports to return.") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }) => {
    const supabase = supabaseAnon();
    const { data, error } = await supabase
      .from("imports")
      .select("id, filename, status, message_count, total_files, chat_parsed, created_at")
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return { ...text(data ?? []), structuredContent: { imports: data ?? [] } };
  },
});
