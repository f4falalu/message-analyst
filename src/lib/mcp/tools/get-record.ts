import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon, text } from "../supabase";

export default defineTool({
  name: "get_record",
  title: "Get record with sources",
  description:
    "Fetch one procurement record by id together with the chat messages and attachment files it was derived from, so the extraction can be audited.",
  inputSchema: { record_id: z.string().uuid().describe("The request record id.") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ record_id }) => {
    const supabase = supabaseAnon();
    const { data: record, error } = await supabase
      .from("request_records")
      .select("*")
      .eq("id", record_id)
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!record) return { content: [{ type: "text", text: "No record with that id." }], isError: true };

    const { data: sources } = await supabase
      .from("record_sources")
      .select("kind, message_id, attachment_id")
      .eq("record_id", record_id);

    const messageIds = (sources ?? []).map((s) => s.message_id).filter((v): v is string => !!v);
    const attachmentIds = (sources ?? []).map((s) => s.attachment_id).filter((v): v is string => !!v);

    const messages = messageIds.length
      ? (await supabase.from("messages").select("seq, sent_at, sender, body, attachment_filename").in("id", messageIds)).data ?? []
      : [];
    const attachments = attachmentIds.length
      ? (await supabase.from("attachments").select("filename, mime_type, ocr_status, raw_text, extracted").in("id", attachmentIds)).data ?? []
      : [];

    const payload = { record, messages, attachments };
    return { ...text(payload), structuredContent: payload };
  },
});
