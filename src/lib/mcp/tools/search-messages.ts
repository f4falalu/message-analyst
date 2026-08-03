import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon, text } from "../supabase";

export default defineTool({
  name: "search_messages",
  title: "Search chat transcript",
  description:
    "Full-text substring search across the archived WhatsApp transcript, returning matching messages with sender, timestamp and any attached filename.",
  inputSchema: {
    query: z.string().min(1).describe("Text to look for in message bodies."),
    import_id: z.string().uuid().optional().describe("Restrict to one import."),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, import_id, limit }) => {
    const supabase = supabaseAnon();
    let q = supabase
      .from("messages")
      .select("id, import_id, seq, sent_at, sender, sender_phone, body, attachment_filename")
      .ilike("body", `%${query}%`)
      .order("seq")
      .limit(limit ?? 50);
    if (import_id) q = q.eq("import_id", import_id);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return { ...text(data ?? []), structuredContent: { messages: data ?? [] } };
  },
});
