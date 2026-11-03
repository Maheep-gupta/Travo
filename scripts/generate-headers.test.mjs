import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cspMode } from "./check-dist.mjs";
import { TEMPLATE_PATH, WILDCARD_SOURCES, expectedHeaders, generatedFor, projectOrigin, renderHeaders } from "./generate-headers.mjs";

const template = readFileSync(TEMPLATE_PATH, "utf8");
const ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";

/** The value of one header in the /* block of a _headers file. */
function header(text, name) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`  ${name}:`));
  return line ? line.slice(name.length + 3).trim() : null;
}

describe("the _headers template", () => {
  it("ships CSP in Report-Only with the hardened directives", () => {
    expect(cspMode(template)).toBe("report-only");
    const csp = header(template, "Content-Security-Policy-Report-Only");
    for (const d of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `connect-src 'self' ${WILDCARD_SOURCES}`,
      "worker-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "require-trusted-types-for 'script'",
      "trusted-types 'none'",
    ]) {
      expect(csp.split(/;\s*/)).toContain(d);
    }
    expect(csp).not.toMatch(/127\.0\.0\.1|localhost|unsafe-/);
  });

  it("sets CORP, COOP, frame denial and turns off Topics", () => {
    expect(header(template, "Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(header(template, "Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(header(template, "X-Frame-Options")).toBe("DENY");
    expect(header(template, "Permissions-Policy")).toContain("browsing-topics=()");
  });
});

describe("projectOrigin", () => {
  it("accepts a bare project URL, with or without a trailing slash", () => {
    expect(projectOrigin(ORIGIN)).toBe(ORIGIN);
    expect(projectOrigin(`  ${ORIGIN}/ `)).toBe(ORIGIN);
    expect(projectOrigin("https://ABCDEFGHIJKLMNOPQRST.Supabase.co")).toBe(ORIGIN);
  });

  it.each([
    ["no scheme", "abcdefghijklmnopqrst.supabase.co"],
    ["http", "http://abcdefghijklmnopqrst.supabase.co"],
    ["wss", "wss://abcdefghijklmnopqrst.supabase.co"],
    ["a wildcard", "https://*.supabase.co"],
    ["credentials", "https://user:pw@abcdefghijklmnopqrst.supabase.co"],
    ["a port", "https://abcdefghijklmnopqrst.supabase.co:8443"],
    ["a path", "https://abcdefghijklmnopqrst.supabase.co/rest/v1"],
    ["a query", "https://abcdefghijklmnopqrst.supabase.co/?x=1"],
    ["loopback", "https://localhost"],
    ["a loopback subdomain", "https://x.localhost"],
    ["an IPv4 literal", "https://127.0.0.1"],
    ["an IPv6 literal", "https://[::1]"],
    ["a single label", "https://intranet"],
    ["header injection", "https://a.supabase.co;script-src"],
    ["a newline", "https://a.supabase.co\nX-Evil: 1"],
    ["empty", ""],
  ])("rejects %s", (_name, input) => {
    expect(() => projectOrigin(input)).toThrow();
  });

  // URL() would silently delete these and parse a different host.
  it.each([
    ["a tab inside the host", "https://abc.supa\tbase.co"],
    ["a LF inside the host", "https://abc.supa\nbase.co"],
    ["a CR inside the host", "https://abc.supa\rbase.co"],
    ["a trailing CRLF", `${ORIGIN}\r\n`],
    ["a leading tab", `\t${ORIGIN}`],
  ])("rejects %s before parsing", (_name, input) => {
    expect(() => projectOrigin(input)).toThrow(/tabs or line breaks/);
  });

  it.each([["https://intranet"], ["https://supabase"]])("rejects the single-label host %s", (input) => {
    expect(() => projectOrigin(input)).toThrow(/single-label/);
  });

  it.each([["https://db.local"], ["https://supabase.internal"], ["https://x.y.lan"], ["https://box.home.arpa"], ["https://HOME.ARPA"]])(
    "rejects the local-network name %s",
    (input) => {
      expect(() => projectOrigin(input)).toThrow(/local or internal/);
    },
  );

  it("still accepts public names that merely contain those words", () => {
    expect(projectOrigin("https://local.example.com")).toBe("https://local.example.com");
    expect(projectOrigin("https://my-lan.supabase.co")).toBe("https://my-lan.supabase.co");
    expect(projectOrigin("https://internalx.dev")).toBe("https://internalx.dev");
  });
});

describe("renderHeaders", () => {
  it("returns the template unchanged for the wildcard", () => {
    expect(renderHeaders(template, null)).toBe(template);
    expect(generatedFor(template)).toBeNull();
  });

  it("replaces only the wildcard sources with the exact origin and marks the file", () => {
    const out = renderHeaders(template, ORIGIN);
    expect(generatedFor(out)).toBe(ORIGIN);
    const csp = header(out, "Content-Security-Policy-Report-Only");
    expect(csp).toContain("connect-src 'self' https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co;");
    expect(out).not.toContain(WILDCARD_SOURCES);
    // Nothing else changes: the marker line plus the template with one substitution.
    expect(out.split("\n").slice(1).join("\n")).toBe(template.replace(WILDCARD_SOURCES, "https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co"));
    expect(cspMode(out)).toBe("report-only");
  });

  it("keeps CRLF line endings when the template has them", () => {
    const crlf = template.replace(/\n/g, "\r\n");
    const out = renderHeaders(crlf, ORIGIN);
    expect(out.startsWith(`# Generated by scripts/generate-headers.mjs for ${ORIGIN}\r\n`)).toBe(true);
    expect(generatedFor(out)).toBe(ORIGIN);
  });

  it("refuses a template that lost, or duplicated, the wildcard sources", () => {
    expect(() => renderHeaders(template.replace(WILDCARD_SOURCES, "https://x.supabase.co"), ORIGIN)).toThrow(/exactly once/);
    expect(() => renderHeaders(`${template}\n# ${WILDCARD_SOURCES}`, ORIGIN)).toThrow(/exactly once/);
  });
});

describe("expectedHeaders (used by check:dist)", () => {
  it("accepts the plain template and a generated file", () => {
    expect(expectedHeaders(template, template)).toBe(template);
    const out = renderHeaders(template, ORIGIN);
    expect(expectedHeaders(template, out)).toBe(out);
  });

  it("catches a generated file edited after generation", () => {
    const out = renderHeaders(template, ORIGIN);
    expect(expectedHeaders(template, out.replace("worker-src 'none'", "worker-src 'self'"))).not.toBe(out.replace("worker-src 'none'", "worker-src 'self'"));
    const widened = out.replace("wss://abcdefghijklmnopqrst.supabase.co", "wss://abcdefghijklmnopqrst.supabase.co https://evil.example");
    expect(expectedHeaders(template, widened)).not.toBe(widened);
  });

  it("throws when the marker names an origin the generator would refuse", () => {
    const forged = `# Generated by scripts/generate-headers.mjs for http://127.0.0.1\n${template}`;
    expect(() => expectedHeaders(template, forged)).toThrow();
  });
});

// Each case spawns `node`; on a loaded machine that alone can exceed vitest's 5 s default.
describe("generate-headers CLI", { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL("./generate-headers.mjs", import.meta.url));
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  it("writes the project-specific file", () => {
    dir = mkdtempSync(join(tmpdir(), "tavro-headers-"));
    const out = join(dir, "_headers");
    expect(run("--project-url", ORIGIN, "--out", out).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(renderHeaders(template, ORIGIN));
  });

  it("writes the wildcard only when asked", () => {
    dir = mkdtempSync(join(tmpdir(), "tavro-headers-"));
    const out = join(dir, "_headers");
    expect(run("--wildcard", "--out", out).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(template);
  });

  it("refuses no mode, both modes, an unknown flag and a bad URL", () => {
    dir = mkdtempSync(join(tmpdir(), "tavro-headers-"));
    const out = join(dir, "_headers");
    expect(run("--out", out).code).toBe(2);
    expect(run("--wildcard", "--project-url", ORIGIN, "--out", out).code).toBe(2);
    expect(run("--wildcard", "--force", "--out", out).code).toBe(2);
    const bad = run("--project-url", "http://127.0.0.1:54321", "--out", out);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("must use https://");
  });
});
