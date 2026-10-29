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
