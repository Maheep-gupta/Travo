// Repeatable browser checks for the built web app.
//
//   npm run build -w @mc/web && npm run e2e -w @mc/web
//
// Serves apps/web/dist plus the test harness from an in-process static server
// on 127.0.0.1 (random port), then runs a locally installed Chrome in
// headless --dump-dom mode against harness/checks.html. No browser automation
// protocol is used (it is blocked on the managed dev laptop), nothing is
// downloaded, and nothing outside 127.0.0.1 is contacted.
//
// Env: E2E_CHROME=<path to chrome/chromium> to override browser detection.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const WEB = resolve(import.meta.dirname, "..");
const DIST = join(WEB, "dist");
const HARNESS = join(WEB, "e2e", "harness");
const TIMEOUT_MS = 7 * 60_000;
// Headless Chrome dumps the DOM once this much *virtual* time has elapsed.
const VIRTUAL_BUDGET_MS = Number(process.env.E2E_VIRTUAL_BUDGET_MS ?? 240_000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
};

function findChrome() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

/** Resolve a URL path inside `root`, refusing traversal outside it. */
function safeJoin(root, urlPath) {
  const p = normalize(join(root, decodeURIComponent(urlPath)));
  return p === root || p.startsWith(root + sep) ? p : null;
}

async function fileIfExists(p) {
  try {
    return (await stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

function startServer() {
  // Fault injection: the harness sets a pattern; matching /assets/ requests get
  // HTTP 503, i.e. a genuine failed chunk download from the app's point of view.
  let failPattern = null;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let file = null;
      const headers = { "cache-control": "no-store" };
      if (url.pathname === "/__e2e/fail") {
        const p = url.searchParams.get("pattern");
        failPattern = p ? new RegExp(p) : null;
        res.writeHead(204, headers).end();
        return;
      }
      if (process.env.E2E_DEBUG && url.pathname.startsWith("/assets/")) console.error(`[e2e] ${req.method} ${url.pathname} fail=${failPattern}`);
      if (failPattern && url.pathname.startsWith("/assets/") && failPattern.test(url.pathname)) {
        res.writeHead(503, headers).end("simulated failure");
        return;
      }
      if (url.pathname.startsWith("/__e2e/")) {
        file = await fileIfExists(safeJoin(HARNESS, url.pathname.slice("/__e2e/".length)));
      } else {
        const candidate = safeJoin(DIST, url.pathname);
        file = candidate && (await fileIfExists(candidate));
        // SPA fallback for client-side routes (not for missing assets).
        if (!file && !url.pathname.startsWith("/assets/")) file = join(DIST, "index.html");
      }
      if (!file) {
        res.writeHead(404, headers).end("not found");
        return;
      }
      res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

function runChrome(chrome, url, profile) {
  return new Promise((resolveRun) => {
    const child = spawn(
      chrome,
      [
        // Keep this flag set minimal: on the managed dev laptop, Chrome exits
        // with Windows error 1260 ("blocked by group policy") when extra
        // switches such as --disable-extensions are added. Do not work around that.
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--window-size=600,1200",
        `--virtual-time-budget=${VIRTUAL_BUDGET_MS}`,
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      killTree(child);
      resolveRun({ stdout, stderr, timedOut: true });
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code, timedOut: false });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ stdout: "", timedOut: false, error: e });
    });
    process.once("SIGINT", () => killTree(child));
  });
}

function decode(html) {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("dist/ not found. Build first: npm run build -w @mc/web");
    return 2;
  }
  if (process.argv.includes("--serve")) {
    // Manual mode: serve only; open the printed URL in your own browser.
    const server = await startServer();
    console.log(`Open http://127.0.0.1:${server.address().port}/__e2e/checks.html  (Ctrl+C to stop)`);
    await new Promise((r) => process.once("SIGINT", r));
    await new Promise((r) => server.close(r));
    return 0;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error("No Chrome/Chromium found. Set E2E_CHROME to its path.");
    return 2;
  }
  const server = await startServer();
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), "tavro-e2e-"));
  console.log(`Serving dist on http://127.0.0.1:${port}  ·  browser: ${chrome}`);
  console.log("Note: interactions are synthetic DOM events, not physical input or screen-reader testing.\n");
  try {
    const { stdout, stderr = "", code, timedOut, error } = await runChrome(chrome, `http://127.0.0.1:${port}/__e2e/checks.html`, profile);
    if (error) {
      console.error(`Could not start the browser: ${error.message}`);
      return 2;
    }
    const block = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout)?.[1];
    const lines = block ? decode(block).split("\n").filter(Boolean) : [];
    for (const l of lines) console.log(l);
    const done = lines.find((l) => l.startsWith("DONE"));
    if (!done) {
      console.error(timedOut ? "\nTimed out before the checks finished." : "\nThe checks did not finish (browser may have been terminated by device policy).");
      console.error(`Browser exit code ${code}; output (${stdout.length} bytes): ${stdout.replace(/\s+/g, " ").slice(0, 400)}`);
      const errs = stderr.split("\n").filter((l) => l.trim() && !/registry_loader|Missing value path/.test(l));
      if (errs.length) console.error(`Browser stderr:\n  ${errs.slice(0, 8).join("\n  ")}`);
      return 1;
    }
    const failed = Number(/DONE (\d+) failed/.exec(done)?.[1] ?? 1);
    console.log(failed ? `\n${failed} check(s) failed.` : "\nAll browser checks passed.");
    return failed ? 1 : 0;
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    // Chrome may hold the profile briefly after exit.
    for (let i = 0; i < 10; i++) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

process.exitCode = await main();
