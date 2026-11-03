import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readRemoteControlPolicy } from "../src/policy.js";

// SYNTHETIC policy files in a temp directory; the real ~/.claude is never read.
const dir = mkdtempSync(join(tmpdir(), "tavro-policy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("readRemoteControlPolicy", () => {
  it("reads the boolean", async () => {
    expect(await readRemoteControlPolicy(file("off.json", '{"restrictions":{"allow_remote_control":{"allowed":false}}}'))).toBe(false);
    expect(await readRemoteControlPolicy(file("on.json", '{"restrictions":{"allow_remote_control":{"allowed":true}}}'))).toBe(true);
  });

  it.each([
    ["missing.json", null],
    ["not-json.json", "not json"],
    ["null.json", "null"],
    ["string.json", '{"restrictions":{"allow_remote_control":{"allowed":"true"}}}'],
    ["empty.json", "{}"],
  ])("returns null (treated as not allowed) for %s", async (name, content) => {
    const p = content === null ? join(dir, name) : file(name, content);
    expect(await readRemoteControlPolicy(p)).toBeNull();
  });

  it("returns null for a directory or an oversized file", async () => {
    const sub = join(dir, "a-directory");
    mkdirSync(sub);
    expect(await readRemoteControlPolicy(sub)).toBeNull();
    const big = `{"restrictions":{"allow_remote_control":{"allowed":true}},"pad":"${"x".repeat(300 * 1024)}"}`;
    expect(await readRemoteControlPolicy(file("big.json", big))).toBeNull();
  });
});
