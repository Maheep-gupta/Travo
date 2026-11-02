import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/connector/test/**/*.test.ts", "apps/web/src/**/*.test.ts", "scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
      {
        // React component tests (Testing Library on jsdom). Kept apart from
        // "unit" so pure tests stay on the faster node environment.
        test: {
          name: "dom",
          include: ["apps/web/src/**/*.dom.test.tsx"],
          environment: "jsdom",
          setupFiles: ["apps/web/src/test-setup.ts"],
        },
      },
      {
        // SQL-level checks of the migrations on PGlite (Postgres in WASM) under
        // a minimal Supabase shim; no Docker needed. NOT a substitute for "db":
        // PostgREST, GoTrue, Realtime and Edge Functions aren't involved.
        test: {
          name: "sql",
          include: ["supabase/sql-tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Requires `npm run db:start` (local Supabase in Docker).
        test: {
          name: "db",
          include: ["supabase/tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
