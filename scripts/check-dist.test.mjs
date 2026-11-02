import { describe, expect, it } from "vitest";
import {
  BUDGET,
  LOCAL_PATH_RULES,
  SECRET_RULES,
  checkManifest,
  cspMode,
  entryScript,
  evaluateBudget,
  findInlineCode,
  localReferences,
  redact,
  scanText,
} from "./check-dist.mjs";

const rules = (text, set) => scanText(text, set).map((f) => f.rule);

describe("findInlineCode", () => {
  it("accepts the shipped index.html shape", () => {
    const html = `<head><script src="/theme-init.js"></script>
      <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      <script type="module" crossorigin src="/assets/index-a.js"></script></head>`;
    expect(findInlineCode(html)).toEqual([]);
  });

  it("flags inline scripts, styles and handlers", () => {
    const html = `<script>x()</script><style>a{}</style><div style="color:red" onclick="y()"></div>`;
    expect(findInlineCode(html)).toEqual([
      "inline <script> without src",
      "inline <style> element",
      "inline style= attribute",
    ]);
    expect(findInlineCode(`<a onclick="y()">`)).toEqual(["inline onclick= attribute"]);
    expect(findInlineCode(`<script src="/a.js">x()</script>`)).toEqual(["<script src> with inline body"]);
  });
});

describe("secret rules", () => {
  it("ignores the client's own key-guard literals", () => {
    const guard = "if(t.startsWith(`sb_secret_`))return!0;return t===`service_role`||t===`supabase_admin`";
    expect(scanText(guard, SECRET_RULES)).toEqual([]);
  });

  it("flags key values, JWTs, private keys and DB URLs", () => {
    expect(rules("sb_secret_0123456789abcdef", SECRET_RULES)).toEqual(["supabase-secret-key"]);
    expect(rules(`"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"`, SECRET_RULES)).toEqual(["jwt-or-base64-json"]);
    expect(rules(`SERVICE_ROLE_KEY="abcdefghijklmnopqrstuvwxyz"`, SECRET_RULES)).toEqual(["service-role-assignment"]);
    expect(rules("-----BEGIN EC PRIVATE KEY-----", SECRET_RULES)).toEqual(["private-key-block"]);
    expect(rules("postgresql://postgres:hunter2@db.example", SECRET_RULES)).toEqual(["postgres-url-with-password"]);
  });

  it("never echoes a full secret", () => {
    expect(redact("sb_secret_0123456789abcdef")).toBe("sb_secre… (26 chars)");
    expect(scanText("sb_secret_0123456789abcdef", SECRET_RULES)[0].match).not.toContain("0123");
  });
});

describe("local path rules", () => {
  it("flags developer-machine paths", () => {
    expect(rules(String.raw`"C:\\Users\\me\\x"`, LOCAL_PATH_RULES)).toEqual(["windows-user-path"]);
    // Forward-slash Windows paths also match the macOS rule; either report is enough.
    expect(rules("C:/Users/me/x", LOCAL_PATH_RULES)).toContain("windows-user-path");
    expect(rules("/home/me/repo", LOCAL_PATH_RULES)).toEqual(["unix-home-path"]);
    expect(rules("/Users/me/repo", LOCAL_PATH_RULES)).toEqual(["macos-user-path"]);
    expect(rules("file:///F:/x", LOCAL_PATH_RULES)).toEqual(["file-url"]);
  });

  it("ignores app routes and URLs", () => {
    expect(scanText(`"/sessions/:id" "https://reactrouter.com/home" "http://127.0.0.1"`, LOCAL_PATH_RULES)).toEqual([]);
  });
});

describe("index.html references", () => {
  const html = `<script src="/theme-init.js"></script><link rel="manifest" href="/manifest.webmanifest">
    <link href="https://example.com/x.css"><script type="module" crossorigin src="/assets/index-a.js?v=1"></script>`;

  it("lists same-origin references only", () => {
    expect(localReferences(html)).toEqual(["/theme-init.js", "/manifest.webmanifest", "/assets/index-a.js"]);
  });

  it("finds the module entry", () => {
    expect(entryScript(html)).toBe("/assets/index-a.js?v=1");
    expect(entryScript(`<script src="/x.js"></script>`)).toBeNull();
  });
});

describe("checkManifest", () => {
  const good = {
    name: "Tavro",
    short_name: "Tavro",
    start_url: "/",
    display: "standalone",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };

  it("accepts a complete manifest", () => {
    expect(checkManifest(JSON.stringify(good), () => true)).toEqual([]);
  });

  it("reports missing fields, icons and files", () => {
    const bad = { ...good, short_name: "", display: "browser", icons: good.icons.slice(2) };
    expect(checkManifest(JSON.stringify(bad), (p) => p !== "/icon-maskable-512.png")).toEqual([
      'manifest missing "short_name"',
      'manifest display "browser" is not installable-app style',
      "manifest needs a 192x192 PNG icon",
      "manifest needs a 512x512 PNG icon",
      "manifest icon missing from dist: /icon-maskable-512.png",
    ]);
    expect(checkManifest("{", () => true)).toEqual(["manifest.webmanifest is not valid JSON"]);
  });
});

describe("evaluateBudget", () => {
  it("applies the entry, chunk and total budgets", () => {
    const within = [{ name: "assets/index.js", gzip: BUDGET.entryGzip }, { name: "assets/a.js", gzip: BUDGET.chunkGzip }];
    expect(evaluateBudget(within, "assets/index.js", { ...BUDGET, totalGzip: 1e9 }).issues).toEqual([]);

    const over = [{ name: "assets/index.js", gzip: BUDGET.entryGzip + 1 }, { name: "assets/a.js", gzip: BUDGET.chunkGzip + 1 }];
    const { total, issues } = evaluateBudget(over, "assets/index.js", { ...BUDGET, totalGzip: 100 });
    expect(total).toBe(BUDGET.entryGzip + BUDGET.chunkGzip + 2);
    expect(issues).toHaveLength(3);
  });
});

describe("cspMode", () => {
  it("ignores comments and distinguishes the two headers", () => {
    expect(cspMode("# Content-Security-Policy: x\n/*\n  Content-Security-Policy-Report-Only: default-src 'none'")).toBe("report-only");
    expect(cspMode("/*\n  Content-Security-Policy: default-src 'none'")).toBe("enforcing");
    expect(cspMode("/*\n  X-Frame-Options: DENY")).toBe("none");
  });
});
