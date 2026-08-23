// Test runner config, deliberately separate from vite.config.ts.
//
// vite.config.ts wraps @lovable.dev/vite-tanstack-config, which injects the
// TanStack Start / nitro / react plugin stack. None of that is needed to
// exercise pure logic, and loading it here would couple the tests to the app's
// build pipeline. Only the "@/..." path alias is shared, which Vite resolves
// natively from tsconfig.json.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
