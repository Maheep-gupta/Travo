import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/connector/test/**/*.test.ts", "apps/web/src/**/*.test.ts", "scripts/**/*.test.mjs"],
          environment: "node",
          // Some tests spawn real child processes (claude-code-process); give them
          // room when the machine is busy. Assertions are unchanged.
          testTimeout: 10_000,
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
          // Full-app renders with fake timers take 2-5 s on an idle laptop and
          // timed out at the 5 s default under CPU contention (2026-11-03). This
          // is a hang ceiling, not a speed target: waitFor deadlines and every
          // assertion are unchanged, so a broken test still fails.
          testTimeout: 15_000,
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
          // PGlite boots Postgres in WASM; one test took 32 s under load.
          testTimeout: 60_000,
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
