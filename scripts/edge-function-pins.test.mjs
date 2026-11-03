// Edge Functions import npm packages by URL-style specifier, outside
// package-lock.json. Every such import must name an exact version, and that
// version must match the lockfile, so a deploy runs the code that was tested.
// Remote URL imports (https://…) are refused outright: their content can
// change under the same URL. The walk is recursive (shared code such as
// `_shared/` included), and import maps (deno.json, import_map.json) are held
// to the same rules.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUNCTIONS = join(ROOT, "supabase", "functions");
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

const SOURCE_RE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const IMPORT_MAP_NAMES = new Set(["deno.json", "import_map.json"]);

/** Every file under `dir`, recursively, as paths relative to `base` with forward slashes. */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return walk(full, base);
    return d.isFile() ? [relative(base, full).split("\\").join("/")] : [];
  });
}

/** npm:/jsr: specifiers in source text: name and (possibly missing) version. */
export function packageSpecifiers(text) {
  return [...text.matchAll(/["'](npm|jsr):((?:@[^/"']+\/)?[^@/"']+)(?:@([^/"']+))?[^"']*["']/g)].map((m) => ({ scheme: m[1], name: m[2], version: m[3] }));
}

/** Remote URLs used as module specifiers: static and dynamic imports, re-exports. */
export function remoteImports(text) {
  const found = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'`](https?:\/\/[^"'`]*)["'`]/g)) found.push(m[1]);
  return found;
}

/**
 * Problems with one import map's entries (`imports` and every `scopes` map):
 * each value must be an exact npm:/jsr: version or a relative path, never a URL.
 */
export function importMapProblems(map) {
  const problems = [];
  const entries = [
    ...Object.entries(map?.imports ?? {}),
    ...Object.values(map?.scopes ?? {}).flatMap((scope) => Object.entries(scope ?? {})),
  ];
  for (const [key, value] of entries) {
    if (typeof value !== "string") problems.push(`${key}: not a string`);
    else if (/^https?:\/\//i.test(value)) problems.push(`${key}: remote URL`);
    else if (/^(?:npm|jsr):/.test(value)) {
      const [spec] = packageSpecifiers(JSON.stringify(value));
      if (!spec || !/^\d+\.\d+\.\d+$/.test(spec.version ?? "")) problems.push(`${key}: not pinned to an exact version`);
      else if (spec.scheme === "npm" && lock.packages[`node_modules/${spec.name}`]?.version !== spec.version) problems.push(`${key}: differs from package-lock.json`);
    } else if (!/^\.{1,2}\//.test(value)) problems.push(`${key}: unrecognised specifier`);
  }
  return problems;
}

const files = walk(FUNCTIONS);
const sources = files.filter((f) => SOURCE_RE.test(f)).map((file) => ({ file, text: readFileSync(join(FUNCTIONS, file), "utf8") }));
const specifiers = sources.flatMap(({ file, text }) => packageSpecifiers(text).map((s) => ({ file, ...s })));
const importMaps = files.filter((f) => IMPORT_MAP_NAMES.has(f.split("/").at(-1)));

describe("Edge Function dependency pins", () => {
  it("finds the pair-host import", () => {
    expect(specifiers.some((s) => s.file === "pair-host/index.ts" && s.name === "@supabase/supabase-js")).toBe(true);
  });

  it("pins every npm:/jsr: import, in every directory, to an exact (lockfile) version", () => {
    const bad = specifiers.filter((s) => !/^\d+\.\d+\.\d+$/.test(s.version ?? "") || (s.scheme === "npm" && s.version !== lock.packages[`node_modules/${s.name}`]?.version));
    expect(bad.map((s) => `${s.file}: ${s.scheme}:${s.name}@${s.version ?? "(none)"}`)).toEqual([]);
  });

  it("has no remote URL imports", () => {
    expect(sources.flatMap(({ file, text }) => remoteImports(text).map((u) => `${file}: ${u}`))).toEqual([]);
  });

  it("has only pinned entries in deno.json / import_map.json, and no unchecked deno.jsonc", () => {
    const problems = importMaps.flatMap((file) => importMapProblems(JSON.parse(readFileSync(join(FUNCTIONS, file), "utf8"))).map((p) => `${file}: ${p}`));
    expect(problems).toEqual([]);
    expect(files.filter((f) => f.endsWith("deno.jsonc")), "deno.jsonc isn't parsed here; use deno.json").toEqual([]);
  });
});

describe("the pin checks themselves", () => {
  const sj = lock.packages["node_modules/@supabase/supabase-js"]?.version;

  it("walks subdirectories, including _shared", () => {
    const dir = mkdtempSync(join(tmpdir(), "tavro-edge-walk-"));
    try {
      mkdirSync(join(dir, "_shared", "deep"), { recursive: true });
      mkdirSync(join(dir, "fn"));
      writeFileSync(join(dir, "_shared", "deep", "util.ts"), "");
      writeFileSync(join(dir, "fn", "index.ts"), "");
      writeFileSync(join(dir, "fn", "deno.json"), "{}");
      expect(walk(dir).sort()).toEqual(["_shared/deep/util.ts", "fn/deno.json", "fn/index.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds remote imports in every form", () => {
    const text = [
      `import x from "https://deno.land/x/a@1.0.0/mod.ts";`,
      `export * from 'https://esm.sh/b@1';`,
      `import "http://example.com/side-effect.js";`,
      `const m = await import("https://cdn.example/c.js");`,
    ].join("\n");
    expect(remoteImports(text)).toHaveLength(4);
    expect(remoteImports(`const url = "https://example.supabase.co";`)).toEqual([]);
  });

  it("flags unpinned, mismatched and remote import-map entries", () => {
    expect(importMapProblems({ imports: { a: `npm:@supabase/supabase-js@${sj}`, b: "./local.ts" } })).toEqual([]);
    expect(importMapProblems({ imports: { a: "npm:@supabase/supabase-js@^2" } })).toEqual(["a: not pinned to an exact version"]);
    expect(importMapProblems({ imports: { a: "npm:@supabase/supabase-js" } })).toEqual(["a: not pinned to an exact version"]);
    expect(importMapProblems({ imports: { a: "npm:@supabase/supabase-js@0.0.1" } })).toEqual(["a: differs from package-lock.json"]);
    expect(importMapProblems({ imports: { a: "https://esm.sh/x" } })).toEqual(["a: remote URL"]);
    expect(importMapProblems({ scopes: { "./": { a: "jsr:@std/http" } } })).toEqual(["a: not pinned to an exact version"]);
  });
});
