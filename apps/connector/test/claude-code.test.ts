import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeProvider,
  ClaudeCommandError,
  parseClaudeAgentsJson,
  parseClaudeAgentsOutput,
  projectLabelFromCwd,
  type CommandResult,
} from "../src/providers/claude-code.js";

// Synthetic recorded stdout only. These tests never spawn `claude`.
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/claude-agents/${name}`, import.meta.url), "utf8");
}

const NOW = new Date("2026-10-29T12:00:00.000Z");

function provider(run: () => Promise<CommandResult>, logs: string[] = []): ClaudeCodeProvider {
  return new ClaudeCodeProvider({ runCommand: run, now: () => NOW, log: (l) => logs.push(l) });
}

describe("parseClaudeAgentsJson", () => {
  it("maps busy and idle sessions", () => {
    const sessions = parseClaudeAgentsJson(fixture("busy-and-idle.txt"), NOW);
    expect(sessions).toEqual([
      {
        external_id: "00000000-0000-4000-8000-000000000001",
        title: "Refactor billing module",
        project_label: "alpha",
        status: "running",
        status_reason: "Claude Code reports the session as busy.",
        last_activity_at: NOW.toISOString(),
        last_event_summary: null,
        started_at: null,
      },
      {
        external_id: "00000000-0000-4000-8000-000000000002",
        title: "Fix flaky login test",
        project_label: "beta",
        status: "waiting_for_input",
        status_reason: expect.stringContaining("idle") as unknown as string,
        last_activity_at: null,
        last_event_summary: null,
        started_at: null,
      },
    ]);
  });

  it("reports unrecognised statuses as unknown with the raw value", () => {
    const [s] = parseClaudeAgentsJson(fixture("unknown-status.txt"), NOW);
    expect(s?.status).toBe("unknown");
    expect(s?.status_reason).toContain("awaiting_permission");
    expect(s?.last_activity_at).toBeNull();
  });

  it("ignores extra fields and uses an optional timestamp when not busy", () => {
    const sessions = parseClaudeAgentsJson(fixture("extra-fields.txt"), NOW);
    expect(sessions).toHaveLength(1);
    const [s] = sessions;
    expect(s?.title).toBeNull();
    expect(s?.project_label).toBe("delta");
    expect(s?.last_activity_at).toBe("2026-10-29T11:58:00.000Z");
    expect(Object.keys(s ?? {}).sort()).toEqual(
      ["external_id", "last_activity_at", "last_event_summary", "project_label", "started_at", "status", "status_reason", "title"].sort(),
    );
  });

  it("skips malformed entries but keeps valid ones", () => {
    const result = parseClaudeAgentsOutput(fixture("malformed-entry.txt"), NOW);
    expect(result.ok).toBe(true);
    // Missing sessionId, a string and null are skipped; a wrongly typed cwd only loses its label.
    expect(result.skipped).toBe(3);
    expect(result.sessions.map((s) => [s.external_id, s.project_label])).toEqual([
      ["00000000-0000-4000-8000-000000000005", "epsilon"],
      ["00000000-0000-4000-8000-000000000007", null],
      ["00000000-0000-4000-8000-000000000008", "eta"],
    ]);
  });

  it("treats empty output as a failure, but an empty array as zero sessions", () => {
    const empty = parseClaudeAgentsOutput(fixture("empty.txt"), NOW);
    expect(empty).toMatchObject({ ok: false, sessions: [] });
    expect(parseClaudeAgentsJson(fixture("empty.txt"), NOW)).toEqual([]);
    expect(parseClaudeAgentsOutput(fixture("empty-array.txt"), NOW)).toEqual({ ok: true, sessions: [], skipped: 0 });
  });

  it("returns [] with a content-free reason for non-JSON output", () => {
    const stdout = fixture("non-json.txt");
    const result = parseClaudeAgentsOutput(stdout, NOW);
    expect(result.ok).toBe(false);
    expect(parseClaudeAgentsJson(stdout, NOW)).toEqual([]);
    if (!result.ok) {
      expect(result.reason).toMatch(/not valid JSON/);
      expect(result.reason).not.toContain("SYNTHETIC-SECRET-MARKER");
    }
  });

  it("rejects non-array JSON", () => {
    for (const stdout of ['{"sessions":[]}', "42", "null", '"busy"']) {
      const result = parseClaudeAgentsOutput(stdout, NOW);
      expect(result.ok).toBe(false);
      expect(result.sessions).toEqual([]);
    }
  });

  it("drops duplicate session ids, keeping the first", () => {
    const stdout = JSON.stringify([
      { sessionId: "00000000-0000-4000-8000-00000000000a", status: "busy" },
      { sessionId: "00000000-0000-4000-8000-00000000000a", status: "idle" },
    ]);
    const result = parseClaudeAgentsOutput(stdout, NOW);
    expect(result.sessions.map((s) => s.status)).toEqual(["running"]);
    expect(result.skipped).toBe(1);
  });

  it("caps strings at the contract limits and strips control characters", () => {
    const stdout = JSON.stringify([
      { sessionId: "00000000-0000-4000-8000-00000000000b", status: "idle", name: `x\n\t${"t".repeat(400)}`, cwd: `/home/dev/${"p".repeat(300)}` },
      { sessionId: "0".repeat(201), status: "idle" },
      { sessionId: "   ", status: "idle" },
    ]);
    const result = parseClaudeAgentsOutput(stdout, NOW);
    // Over-long and blank ids are skipped rather than truncated (truncation could collide).
    expect(result.skipped).toBe(2);
    const [s] = result.sessions;
    expect(s?.title).toHaveLength(300);
    expect(s?.title?.startsWith("x t")).toBe(true);
    expect(s?.project_label).toHaveLength(200);
    expect(s?.status_reason.length).toBeLessThanOrEqual(500);
  });

  it("never reports a timestamp later than now and ignores invalid ones", () => {
    const stdout = JSON.stringify([
      { sessionId: "00000000-0000-4000-8000-00000000000c", status: "idle", lastActivityAt: "2099-01-01T00:00:00Z" },
      { sessionId: "00000000-0000-4000-8000-00000000000d", status: "idle", lastActivityAt: "yesterday-ish" },
      { sessionId: "00000000-0000-4000-8000-00000000000e", status: "idle", updatedAt: Date.parse("2026-10-29T10:00:00Z") },
    ]);
    expect(parseClaudeAgentsJson(stdout, NOW).map((s) => s.last_activity_at)).toEqual([
      NOW.toISOString(),
      null,
      "2026-10-29T10:00:00.000Z",
    ]);
  });
});

describe("projectLabelFromCwd", () => {
  it.each([
    ["/home/dev/projects/alpha", "alpha"],
    ["/home/dev/projects/alpha/", "alpha"],
    ["C:\\Users\\name\\proj", "proj"],
    ["C:\\Users\\name\\proj\\", "proj"],
    ["D:/work/mixed\\sep", "sep"],
    ["\\\\server\\share\\proj", "proj"],
    ["relative-dir", "relative-dir"],
  ])("%s -> %s", (cwd, label) => {
    expect(projectLabelFromCwd(cwd)).toBe(label);
  });

  it.each([
    ["/"],
    ["C:\\"],
    ["C:"],
    [""],
    ["/home/dev"],
    ["/Users/dev/"],
    ["C:\\Users\\name"],
    ["/mnt/c/Users/name"],
    ["/root"],
  ])("%s -> null (root or home directory)", (cwd) => {
    expect(projectLabelFromCwd(cwd)).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(projectLabelFromCwd(42)).toBeNull();
    expect(projectLabelFromCwd(null)).toBeNull();
    expect(projectLabelFromCwd(undefined)).toBeNull();
  });
});

describe("ClaudeCodeProvider", () => {
  it("is a non-demo claude-code provider without transcript access", () => {
    const p = provider(async () => ({ stdout: "[]", exitCode: 0 }));
    expect(p.id).toBe("claude-code");
    expect(p.isDemo).toBe(false);
    expect("messages" in p).toBe(false);
  });

  it("returns parsed sessions and logs skipped entries without content", async () => {
    const logs: string[] = [];
    const p = provider(async () => ({ stdout: fixture("malformed-entry.txt"), exitCode: 0 }), logs);
    expect(await p.poll()).toHaveLength(3);
    expect(logs).toEqual(["claude-code: skipped 3 malformed or duplicate session entries."]);
  });

  it("rejects on a non-zero exit without leaking stdout", async () => {
    const p = provider(async () => ({ stdout: fixture("non-json.txt"), exitCode: 2 }));
    await expect(p.poll()).rejects.toThrow("claude agents --json exited with code 2.");
  });

  it.each(["non-json.txt", "empty.txt"])("rejects on unparseable output (%s) without leaking it", async (name) => {
    const err = await provider(async () => ({ stdout: fixture(name), exitCode: 0 }))
      .poll()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("SYNTHETIC-SECRET-MARKER");
    expect((err as Error).message).not.toContain("/home/dev");
  });

  it("passes through fixed runner failure messages", async () => {
    const p = provider(async () => {
      throw new ClaudeCommandError("timeout");
    });
    await expect(p.poll()).rejects.toThrow("claude agents --json timed out.");
  });

  it("replaces arbitrary runner error messages with a fixed one", async () => {
    const p = provider(async () => {
      throw new Error("Command failed: SYNTHETIC-SECRET-MARKER /home/dev/projects/alpha");
    });
    const err = (await p.poll().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("claude agents --json could not be started.");
  });
});
