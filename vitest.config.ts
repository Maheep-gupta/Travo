import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/connector/test/**/*.test.ts", "apps/web/src/**/*.test.ts"],
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
