import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon, text } from "../supabase";

export default defineTool({
  name: "search_records",
  title: "Search procurement records",
  description:
    "Search the extracted procurement ledger: facility name, items, amount paid, request/payment dates, requester contact, status and data issues. Filter by import, facility text, status, review flag or date range.",
  inputSchema: {
    import_id: z.string().uuid().optional().describe("Restrict to one import."),
    facility: z.string().optional().describe("Case-insensitive substring of the facility name."),
    status: z.string().optional().describe("Record status, e.g. 'paid' or 'pending'."),
    needs_review: z.boolean().optional().describe("Only records flagged for human review."),
    from_date: z.string().optional().describe("Earliest request date, YYYY-MM-DD."),
    to_date: z.string().optional().describe("Latest request date, YYYY-MM-DD."),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (input) => {
    const supabase = supabaseAnon();
    let query = supabase
      .from("request_records")
      .select(
        "id, import_id, facility_name, items, amount_paid, currency, request_date, payment_date, requester_name, requester_phone, status, confidence, needs_review, issues, notes",
      )
      .order("request_date", { ascending: false, nullsFirst: false })
      .limit(input.limit ?? 50);

    if (input.import_id) query = query.eq("import_id", input.import_id);
    if (input.facility) query = query.ilike("facility_name", `%${input.facility}%`);
    if (input.status) query = query.eq("status", input.status);
    if (typeof input.needs_review === "boolean") query = query.eq("needs_review", input.needs_review);
    if (input.from_date) query = query.gte("request_date", input.from_date);
    if (input.to_date) query = query.lte("request_date", input.to_date);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return { ...text(data ?? []), structuredContent: { records: data ?? [] } };
  },
});
