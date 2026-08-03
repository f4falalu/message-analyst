import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon, text } from "../supabase";

export default defineTool({
  name: "import_summary",
  title: "Summarise an import",
  description:
    "Processing and data-quality summary for one import: attachment OCR progress, record counts, records needing review, and total amount paid.",
  inputSchema: { import_id: z.string().uuid().describe("The import to summarise.") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ import_id }) => {
    const supabase = supabaseAnon();
    const { data: imp, error } = await supabase
      .from("imports")
      .select("id, filename, status, message_count, total_files, chat_parsed, created_at")
      .eq("id", import_id)
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!imp) return { content: [{ type: "text", text: "No import with that id." }], isError: true };

    const { data: attachments } = await supabase
      .from("attachments")
      .select("ocr_status")
      .eq("import_id", import_id);
    const ocr: Record<string, number> = {};
    for (const a of attachments ?? []) ocr[a.ocr_status] = (ocr[a.ocr_status] ?? 0) + 1;

    const { data: records } = await supabase
      .from("request_records")
      .select("amount_paid, needs_review, status")
      .eq("import_id", import_id);
    const rows = records ?? [];

    const payload = {
      import: imp,
      attachments_by_ocr_status: ocr,
      record_count: rows.length,
      needs_review_count: rows.filter((r) => r.needs_review).length,
      total_amount_paid: rows.reduce((sum, r) => sum + (r.amount_paid ?? 0), 0),
    };
    return { ...text(payload), structuredContent: payload };
  },
});
