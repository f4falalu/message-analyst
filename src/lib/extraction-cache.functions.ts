// Server functions for the extracted-ledger cache.

import { createServerFn } from "@tanstack/react-start";

/** Restore every file in this import that was already read in an earlier pass. */
export const restoreCachedReads = createServerFn({ method: "POST" })
  .inputValidator((input: { importId: string }) => ({ importId: String(input.importId) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    const { applyCachedExtractions } = await import("./extraction-cache.server");
    return applyCachedExtractions(supabase, data.importId);
  });
