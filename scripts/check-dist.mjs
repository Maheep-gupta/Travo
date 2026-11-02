#!/usr/bin/env node
// Release gate for the static web build. Run after `npm run build -w @mc/web`:
//   npm run check:dist            (or: node scripts/check-dist.mjs [distDir])
// Fails (exit 1) when apps/web/dist would be unsafe or unfit to publish:
//   - index.html has an inline <script>, inline <style>, style= or on*= attribute
//     (the deploy CSP is script-src 'self'; style-src 'self', see deploy/cloudflare/_headers);
//   - any text file contains something that looks like a secret or a local path;
//   - a source map ships, or a service worker is registered (D-011);
//   - the manifest, its icons or files referenced by index.html are missing;
//   - gzip sizes exceed BUDGET.
// Offline, read-only, zero dependencies. Pure functions are exported for
// scripts/check-dist.test.mjs; the CLI runs only when this file is executed.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Gzip budgets in bytes (1 kB = 1000 B, as Vite reports). Set 2026-11-02 at
 * roughly 20% above the measured build so growth is a deliberate decision:
 *   entry chunk 70.6 kB, largest other chunk 56.9 kB (Supabase mode only),
 *   all JS + CSS 220.9 kB (node:zlib level 9; Vite's figures differ by ~1%).
 *   Raise a budget only with a note in docs/QUALITY.md.
 */
export const BUDGET = {
  entryGzip: 86_000,
  chunkGzip: 70_000,
  totalGzip: 270_000,
};

// Extensions scanned as text. Anything else (PNG etc.) is skipped by the content scan.
const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".txt", ".xml", ".map"]);

/** Secret-looking values. Bare words like "sb_secret_" or "service_role" are fine:
 *  the client's own key guard contains them. These rules match key *values*. */
export const SECRET_RULES = [
  { id: "supabase-secret-key", re: /sb_secret_[A-Za-z0-9_-]{12,}/g },
  { id: "jwt-or-base64-json", re: /\beyJ[A-Za-z0-9_-]{30,}/g },
  { id: "service-role-assignment", re: /service_?role_?key["'`]?\s*[:=]\s*["'`][^"'`\s]{20,}/gi },
  { id: "private-key-block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { id: "postgres-url-with-password", re: /postgres(?:ql)?:\/\/[^:/\s"'`]+:[^@\s"'`]+@/gi },
];

/** Absolute developer-machine paths, which leak usernames and folder layout. */
export const LOCAL_PATH_RULES = [
  { id: "windows-user-path", re: /\b[A-Za-z]:(?:\\\\|\\|\/)(?:Users|Documents and Settings)(?:\\\\|\\|\/)/gi },
  { id: "unix-home-path", re: /\/home\/[A-Za-z0-9._-]+\//g },
  { id: "macos-user-path", re: /\/Users\/[A-Za-z0-9._-]+\//g },
  { id: "file-url", re: /file:\/\/\//gi },
];

const SERVICE_WORKER_RE = /serviceWorker\s*\.\s*register\s*\(/g;
const SOURCE_MAP_COMMENT_RE = /[#@]\s*sourceMappingURL=/g;

/** Never print a matched secret: keep a short prefix only. */
export function redact(match) {
  return match.length <= 8 ? match : `${match.slice(0, 8)}… (${match.length} chars)`;
}

/** Runs rules over text and returns findings with redacted matches. */
export function scanText(text, rules) {
  const findings = [];
  for (const { id, re } of rules) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) findings.push({ rule: id, match: redact(m[0]) });
  }
  return findings;
}

/** Inline code in index.html that a strict CSP (script-src/style-src 'self') would block. */
export function findInlineCode(html) {
  const issues = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    if (!/\ssrc\s*=/i.test(` ${attrs}`)) issues.push("inline <script> without src");
    else if (m[2].trim() !== "") issues.push("<script src> with inline body");
  }
  if (/<style\b/i.test(html)) issues.push("inline <style> element");
  for (const m of html.matchAll(/<[a-z][^>]*?\s(on[a-z]+|style)\s*=/gi)) {
    issues.push(`inline ${m[1].toLowerCase()}= attribute`);
  }
  return issues;
}

/** Same-origin src/href values in index.html (absolute-path URLs only). */
export function localReferences(html) {
  const refs = new Set();
  for (const m of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = m[1];
    if (url.startsWith("/") && !url.startsWith("//")) refs.add(url.split(/[?#]/)[0]);
  }
  return [...refs];
}

/** The module script index.html loads first, e.g. "/assets/index-abc.js". */
export function entryScript(html) {
  const m = /<script\b[^>]*type\s*=\s*["']module["'][^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(html)
    ?? /<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*type\s*=\s*["']module["']/i.exec(html);
  return m ? m[1] : null;
}

/**
 * Checks the web manifest. `exists(path)` answers whether "/x.png" is in dist.
 * Installability itself needs a browser and stays unverified.
 */
export function checkManifest(text, exists) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return ["manifest.webmanifest is not valid JSON"];
  }
  const issues = [];
  for (const key of ["name", "short_name", "start_url", "display"]) {
    if (typeof manifest[key] !== "string" || manifest[key] === "") issues.push(`manifest missing "${key}"`);
  }
  if (manifest.display && !["standalone", "fullscreen", "minimal-ui"].includes(manifest.display)) {
    issues.push(`manifest display "${manifest.display}" is not installable-app style`);
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const purposes = (i) => String(i.purpose ?? "any").split(/\s+/);
  const has = (size, purpose) =>
    icons.some((i) => i.type === "image/png" && String(i.sizes).split(/\s+/).includes(size) && purposes(i).includes(purpose));
  if (!has("192x192", "any")) issues.push("manifest needs a 192x192 PNG icon");
  if (!has("512x512", "any")) issues.push("manifest needs a 512x512 PNG icon");
  if (!icons.some((i) => purposes(i).includes("maskable"))) issues.push("manifest needs a maskable icon");
  for (const icon of icons) {
    if (typeof icon.src !== "string" || !exists(icon.src)) issues.push(`manifest icon missing from dist: ${icon.src}`);
  }
  return issues;
}

/** Budget verdicts. `assets` is [{ name, gzip }] for every .js/.css file. */
export function evaluateBudget(assets, entryName, budget = BUDGET) {
  const issues = [];
  const total = assets.reduce((sum, a) => sum + a.gzip, 0);
  for (const a of assets) {
    const limit = a.name === entryName ? budget.entryGzip : budget.chunkGzip;
    if (a.gzip > limit) issues.push(`${a.name} is ${kB(a.gzip)} gzip, over its ${kB(limit)} budget`);
  }
  if (total > budget.totalGzip) issues.push(`total JS+CSS is ${kB(total)} gzip, over the ${kB(budget.totalGzip)} budget`);
  return { total, issues };
}

/** Which CSP mode a Cloudflare _headers file is in. */
export function cspMode(headersText) {
  const lines = headersText.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"));
  if (lines.some((l) => /^\s+Content-Security-Policy\s*:/i.test(l))) return "enforcing";
  if (lines.some((l) => /^\s+Content-Security-Policy-Report-Only\s*:/i.test(l))) return "report-only";
  return "none";
}

export function kB(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main(distDir) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  if (!existsSync(join(distDir, "index.html"))) {
    console.error(`check:dist: ${distDir}/index.html not found. Run \`npm run build -w @mc/web\` first.`);
    return 1;
  }
  const files = walk(distDir);
  const rel = (p) => relative(distDir, p).split(sep).join("/");
  const inDist = (urlPath) => existsSync(join(distDir, ...urlPath.replace(/^\//, "").split("/")));

  // 1. index.html: CSP-compatible markup, references that resolve.
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  for (const issue of findInlineCode(html)) fail(`index.html: ${issue}`);
  for (const ref of localReferences(html)) if (!inDist(ref)) fail(`index.html references missing file ${ref}`);
  if (!/rel\s*=\s*["']manifest["']/i.test(html)) fail("index.html has no <link rel=\"manifest\">");
  const entry = entryScript(html);
  if (!entry) fail("index.html has no module entry script");

  // 2. Manifest and icons.
  if (!inDist("/manifest.webmanifest")) fail("manifest.webmanifest missing");
  else for (const issue of checkManifest(readFileSync(join(distDir, "manifest.webmanifest"), "utf8"), inDist)) fail(issue);
  if (!inDist("/apple-touch-icon.png")) fail("apple-touch-icon.png missing (iOS Home Screen icon)");

  // 3. Content scan: secrets, local paths, source maps, service workers.
  for (const file of files) {
    const name = rel(file);
    if (name.endsWith(".map")) fail(`source map shipped: ${name}`);
    if (/(^|\/)(sw|service-worker)\.js$/i.test(name)) fail(`service worker file shipped: ${name} (D-011)`);
    if (!TEXT_EXT.has(extname(file).toLowerCase()) && name !== "_headers") continue;
    const text = readFileSync(file, "utf8");
    for (const f of scanText(text, SECRET_RULES)) fail(`${name}: possible secret (${f.rule}): ${f.match}`);
    for (const f of scanText(text, LOCAL_PATH_RULES)) fail(`${name}: local path (${f.rule}): ${f.match}`);
    SOURCE_MAP_COMMENT_RE.lastIndex = 0;
    if (SOURCE_MAP_COMMENT_RE.test(text)) fail(`${name}: sourceMappingURL comment`);
    SERVICE_WORKER_RE.lastIndex = 0;
    if (SERVICE_WORKER_RE.test(text)) fail(`${name}: registers a service worker (D-011)`);
  }

  // 4. Optional deploy-time _headers (copied in by docs/DEPLOYMENT.md, never by the build).
  if (inDist("/_headers")) {
    const shipped = readFileSync(join(distDir, "_headers"), "utf8");
    const template = join(ROOT, "deploy", "cloudflare", "_headers");
    if (existsSync(template) && readFileSync(template, "utf8") !== shipped) {
      fail("dist/_headers differs from deploy/cloudflare/_headers");
    }
    console.log(`_headers present; CSP mode: ${cspMode(shipped)}`);
  } else {
    console.log("_headers not present (expected before deployment staging)");
  }

  // 5. Sizes.
  const assets = files
    .filter((f) => /\.(js|css)$/.test(f) && rel(f).startsWith("assets/"))
    .map((f) => {
      const buf = readFileSync(f);
      return { name: rel(f), raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
    })
    .sort((a, b) => b.gzip - a.gzip);
  const entryName = entry ? entry.replace(/^\//, "") : null;
  const { total, issues } = evaluateBudget(assets, entryName);
  console.log("\nChunk sizes (gzip level 9):");
  for (const a of assets) {
    const tag = a.name === entryName ? "  [entry]" : "";
    console.log(`  ${a.name.padEnd(42)} ${kB(a.raw).padStart(10)} raw ${kB(a.gzip).padStart(10)} gzip${tag}`);
  }
  console.log(`  ${"total JS+CSS".padEnd(42)} ${kB(assets.reduce((s, a) => s + a.raw, 0)).padStart(10)} raw ${kB(total).padStart(10)} gzip`);
  console.log(`Budgets: entry ${kB(BUDGET.entryGzip)}, other chunks ${kB(BUDGET.chunkGzip)}, total ${kB(BUDGET.totalGzip)} (gzip)`);
  issues.forEach(fail);

  if (failures.length > 0) {
    console.error(`\ncheck:dist FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`\ncheck:dist passed: ${files.length} files in ${relative(ROOT, distDir).split(sep).join("/") || distDir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distDir = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "apps", "web", "dist");
  process.exitCode = main(distDir);
}
