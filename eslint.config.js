import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "supabase/functions/**", "apps/web/test-results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Playwright scripts: page.evaluate callbacks run in the browser.
    files: ["apps/web/e2e/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Harness scripts run inside the browser under test.
    files: ["apps/web/e2e/harness/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
  },
  {
    // Shared packages must stay platform-neutral (web, React Native, Deno, Node).
    // Their tsconfigs include Node types only so tests compile; these rules keep
    // Node and DOM APIs out of the source.
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["react", "react-*", "node:*", "@tanstack/*", "fs", "path", "child_process", "os", "crypto"] },
      ],
      "no-restricted-globals": ["error", "window", "document", "localStorage", "sessionStorage", "navigator", "process", "Buffer", "require", "__dirname"],
    },
  },
  {
    // Only api-client may talk to Supabase; domain/contracts/demo stay storage-agnostic.
    files: ["packages/domain/src/**/*.ts", "packages/contracts/src/**/*.ts", "packages/demo/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["react", "react-*", "node:*", "@tanstack/*", "@supabase/*", "fs", "path", "child_process", "os", "crypto"] },
      ],
    },
  },
);
