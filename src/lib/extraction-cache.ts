// Shared (client-safe) key for the "already read this document" cache.
//
// WhatsApp exports name every attachment after its timestamp, so filename plus
// byte size identifies the same scan across imports and across restarts.

export function contentKeyFor(filename: string, sizeBytes: number | null | undefined): string {
  const name = String(filename).trim().toLowerCase();
  return `${name}::${sizeBytes ?? 0}`;
}
