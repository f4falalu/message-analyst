import * as XLSX from "xlsx";

export type ExportRecord = {
  facility_name: string | null;
  items: { name: string; quantity: number | null; unit: string | null; amount: number | null }[];
  amount_paid: number | null;
  currency: string | null;
  request_date: string | null;
  payment_date: string | null;
  requester_name: string | null;
  requester_phone: string | null;
  status: string;
  confidence: number | null;
  needs_review: boolean;
  notes: string | null;
};

function itemsToText(items: ExportRecord["items"]): string {
  return items
    .map((item) => {
      const qty = item.quantity !== null ? `${item.quantity}${item.unit ? ` ${item.unit}` : ""} x ` : "";
      const amount = item.amount !== null ? ` — ${item.amount}` : "";
      return `${qty}${item.name}${amount}`;
    })
    .join("\n");
}

export function exportRecordsToXlsx(records: ExportRecord[], filename: string) {
  const flat = records.map((record) => ({
    "Facility": record.facility_name ?? "",
    "Items & quantities": itemsToText(record.items),
    "Item count": record.items.length,
    "Amount paid": record.amount_paid ?? "",
    "Currency": record.currency ?? "",
    "Date of request": record.request_date ?? "",
    "Date of payment": record.payment_date ?? "",
    "Contact name": record.requester_name ?? "",
    "Contact phone": record.requester_phone ?? "",
    "Status": record.status,
    "Confidence": record.confidence ?? "",
    "Needs review": record.needs_review ? "Yes" : "No",
    "Notes": record.notes ?? "",
  }));

  const sheet = XLSX.utils.json_to_sheet(flat);
  sheet["!cols"] = [
    { wch: 28 },
    { wch: 52 },
    { wch: 10 },
    { wch: 14 },
    { wch: 10 },
    { wch: 16 },
    { wch: 16 },
    { wch: 22 },
    { wch: 18 },
    { wch: 12 },
    { wch: 11 },
    { wch: 13 },
    { wch: 40 },
  ];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Requests");
  XLSX.writeFile(book, filename);
}
