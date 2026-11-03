import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNRECOGNISED_STATUS_REASON } from "@mc/domain";
import {
  ClaudeCodeProvider,
  ClaudeCommandError,
  VERSION_RECHECK_MS,
  cleanText,
  formatClaudeCodeDiagnosis,
  generatedSessionTitle,
  localUsername,
  parseClaudeAgentsJson,
  parseClaudeAgentsOutput,
  projectLabelFromCwd,
  type CommandResult,
} from "../src/providers/claude-code.js";

// SYNTHETIC recorded stdout only (see fixtures/claude-agents/README.md).
// These tests never spawn `claude`; passing them proves nothing about a live CLI.
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/claude-agents/${name}`, import.meta.url), "utf8");
}

const NOW = new Date("2026-10-29T12:00:00.000Z");
const CLI_NAMES = { titlePolicy: "cli_name" } as const;
const SYNTHETIC_VERSION: CommandResult = { stdout: "2.1.312 (Claude Code)\n", exitCode: 0 };
/** Two sessions, the first listed twice. */
const DUPLICATES = JSON.stringify([
  { sessionId: "00000000-0000-4000-8000-000000000005", status: "busy", name: "Write migration", cwd: "/home/dev/projects/epsilon" },
  { sessionId: "00000000-0000-4000-8000-000000000005", status: "idle", name: "Write migration", cwd: "/home/dev/projects/epsilon" },
  { sessionId: "00000000-0000-4000-8000-000000000008", status: "idle", cwd: "/home/dev/projects/eta" },
]);

interface Harness {
  run?: () => Promise<CommandResult>;
  version?: () => Promise<CommandResult>;
  logs?: string[];
  now?: () => Date;
  titlePolicy?: "generated" | "cli_name";
}

function provider(run: () => Promise<CommandResult>, logs: string[] = []): ClaudeCodeProvider {
  return harness({ run, logs });
}

function harness(h: Harness): ClaudeCodeProvider {
  const logs = h.logs ?? [];
  return new ClaudeCodeProvider({
    runCommand: h.run ?? (async () => ({ stdout: "[]", exitCode: 0 })),
    runVersion: h.version ?? (async () => SYNTHETIC_VERSION),
    now: h.now ?? (() => NOW),
    log: (l) => logs.push(l),
    ...(h.titlePolicy ? { titlePolicy: h.titlePolicy } : {}),
  });
}

async function failure(p: ClaudeCodeProvider): Promise<ClaudeCommandError> {
  const err = await p.poll().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ClaudeCommandError);
  return err as ClaudeCommandError;
}

describe("parseClaudeAgentsJson", () => {
  it("maps busy and idle sessions", () => {
    const sessions = parseClaudeAgentsJson(fixture("busy-and-idle.txt"), NOW, CLI_NAMES);
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

  it("reports unrecognised statuses as unknown with a fixed reason, never the raw value", () => {
    const [s] = parseClaudeAgentsJson(fixture("unknown-status.txt"), NOW);
    expect(s?.status).toBe("unknown");
    expect(s?.status_reason).toBe(UNRECOGNISED_STATUS_REASON);
    expect(JSON.stringify(s)).not.toContain("awaiting_permission");
    expect(s?.last_activity_at).toBeNull();
  });

  it.each([["BUSY"], [" busy"], ["busy\u0000"], [1], [true], [null], [{ busy: true }]])("never guesses a status from %j", (status) => {
    const [s] = parseClaudeAgentsJson(JSON.stringify([{ sessionId: "00000000-0000-4000-8000-0000000000f1", status }]), NOW);
    expect(s?.status).toBe("unknown");
    expect(s?.status_reason).toBe(UNRECOGNISED_STATUS_REASON);
  });

  it("ignores extra fields and uses an optional timestamp when not busy", () => {
    const sessions = parseClaudeAgentsJson(fixture("extra-fields.txt"), NOW, CLI_NAMES);
    expect(sessions).toHaveLength(1);
    const [s] = sessions;
    expect(s?.title).toBeNull();
    expect(s?.project_label).toBe("delta");
    expect(s?.last_activity_at).toBe("2026-10-29T11:58:00.000Z");
    expect(Object.keys(s ?? {}).sort()).toEqual(
      ["external_id", "last_activity_at", "last_event_summary", "project_label", "started_at", "status", "status_reason", "title"].sort(),
    );
  });

  it("fails the whole read when any entry can't be identified, so a known session isn't marked ended", () => {
    // Missing sessionId, a string and null: any one of them could be a session we already know.
    const result = parseClaudeAgentsOutput(fixture("malformed-entry.txt"), NOW);
    expect(result).toMatchObject({ ok: false, kind: "unidentified_entries", sessions: [] });
    if (!result.ok) {
      expect(result.reason).toMatch(/without a usable session id/);
      expect(result.reason).not.toContain("zeta");
    }
    expect(parseClaudeAgentsJson(fixture("malformed-entry.txt"), NOW)).toEqual([]);
  });

  it("keeps an entry whose only problem is a wrongly typed cwd, without a label", () => {
    const stdout = JSON.stringify([{ sessionId: "00000000-0000-4000-8000-000000000007", status: "idle", cwd: 42 }]);
    expect(parseClaudeAgentsOutput(stdout, NOW)).toMatchObject({ ok: true, skipped: 0, sessions: [{ project_label: null }] });
  });

  it("treats empty output as a failure, but an empty array as zero sessions", () => {
    const empty = parseClaudeAgentsOutput(fixture("empty.txt"), NOW);
    expect(empty).toMatchObject({ ok: false, sessions: [], kind: "empty_output" });
    expect(parseClaudeAgentsJson(fixture("empty.txt"), NOW)).toEqual([]);
    expect(parseClaudeAgentsOutput(fixture("empty-array.txt"), NOW)).toEqual({ ok: true, sessions: [], skipped: 0 });
  });

  it("returns [] with a content-free reason for non-JSON output", () => {
    const stdout = fixture("non-json.txt");
    const result = parseClaudeAgentsOutput(stdout, NOW);
    expect(result.ok).toBe(false);
    expect(parseClaudeAgentsJson(stdout, NOW)).toEqual([]);
    if (!result.ok) {
      expect(result.kind).toBe("invalid_json");
      expect(result.reason).toMatch(/not valid JSON/);
      expect(result.reason).not.toContain("SYNTHETIC-SECRET-MARKER");
    }
  });

  it("treats truncated (partial) JSON as invalid, never as a shorter list", () => {
    const result = parseClaudeAgentsOutput(fixture("truncated.txt"), NOW);
    expect(result).toMatchObject({ ok: false, kind: "invalid_json", sessions: [] });
    if (!result.ok) expect(result.reason).not.toContain("SYNTHETIC-SECRET-MARKER");
  });

  it("fails when no entry is recognisable (a renamed format), so sessions aren't marked ended", () => {
    const result = parseClaudeAgentsOutput(fixture("renamed-keys.txt"), NOW);
    expect(result).toMatchObject({ ok: false, kind: "unrecognised_entries", sessions: [] });
    if (!result.ok) expect(result.reason).not.toContain("SYNTHETIC-SECRET-MARKER");
  });

  it("accepts a leading byte-order mark", () => {
    expect(parseClaudeAgentsOutput(`\uFEFF${fixture("busy-and-idle.txt")}`, NOW)).toMatchObject({ ok: true, skipped: 0 });
  });

  it("rejects non-array JSON", () => {
    for (const [stdout, kind] of [['{"sessions":[]}', "not_array"], ["42", "not_array"], ["null", "not_array"], ['"busy"', "not_array"]] as const) {
      const result = parseClaudeAgentsOutput(stdout, NOW);
      expect(result).toMatchObject({ ok: false, sessions: [], kind });
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

  it("refuses over-long and blank ids rather than truncating them (truncation could collide)", () => {
    for (const sessionId of ["0".repeat(201), "   "]) {
      const stdout = JSON.stringify([{ sessionId: "00000000-0000-4000-8000-00000000000b", status: "idle" }, { sessionId, status: "idle" }]);
      expect(parseClaudeAgentsOutput(stdout, NOW)).toMatchObject({ ok: false, kind: "unidentified_entries" });
    }
  });

  it("caps strings at the contract limits and strips control characters", () => {
    const stdout = JSON.stringify([
      { sessionId: "00000000-0000-4000-8000-00000000000b", status: "idle", name: `x\n\t${"t".repeat(400)}`, cwd: `/home/dev/${"p".repeat(300)}` },
    ]);
    const result = parseClaudeAgentsOutput(stdout, NOW, CLI_NAMES);
    expect(result.skipped).toBe(0);
    const [s] = result.sessions;
    expect(s?.title).toHaveLength(300);
    expect(s?.title?.startsWith("x t")).toBe(true);
    expect(s?.project_label).toHaveLength(200);
    expect(s?.status_reason.length).toBeLessThanOrEqual(500);
  });

  it.each([[" 00000000-0000-4000-8000-0000000000f2"], ["00000000-0000-4000-8000-0000000000f3\n"], ["00000000\u202e-0000"]])(
    "refuses the read for id %j instead of trimming it",
    (sessionId) => {
      const stdout = JSON.stringify([{ sessionId, status: "idle" }, { sessionId: "00000000-0000-4000-8000-0000000000f4", status: "idle" }]);
      expect(parseClaudeAgentsOutput(stdout, NOW)).toMatchObject({ ok: false, kind: "unidentified_entries", sessions: [] });
    },
  );

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

describe("session identity", () => {
  it("keys sessions by sessionId only: stable across runs, pids and ordering", () => {
    const run1 = parseClaudeAgentsJson(fixture("busy-and-idle.txt"), NOW);
    const reordered = (JSON.parse(fixture("busy-and-idle.txt")) as { pid: number }[]).reverse().map((e, i) => ({ ...e, pid: 90_000 + i }));
    const run2 = parseClaudeAgentsJson(JSON.stringify(reordered), new Date(NOW.getTime() + 60_000));
    const ids = (s: { external_id: string }[]) => s.map((x) => x.external_id).sort();
    expect(ids(run2)).toEqual(ids(run1));
    // Generated titles derive from the id too, so they don't change either.
    expect(run2.map((s) => s.title).sort()).toEqual(run1.map((s) => s.title).sort());
  });
});

describe("title policy (D-004 / D-013)", () => {
  it("defaults to a generated, content-free label: CLI names never leave the parser", () => {
    const stdout = JSON.stringify([{ sessionId: "00000000-0000-4000-8000-0000abcdef12", status: "busy", name: "SYNTHETIC-SECRET-MARKER from a prompt" }]);
    const [s] = parseClaudeAgentsJson(stdout, NOW);
    expect(s?.title).toBe("Session abcdef12");
    expect(JSON.stringify(s)).not.toContain("SYNTHETIC-SECRET-MARKER");
    expect(generatedSessionTitle("abc")).toBe("Session abc");
    expect(generatedSessionTitle("0190a5b2-7c00-7000-8000-00000000beef")).toBe("Session 0000beef");
  });

  it("uses the CLI name only when opted in", () => {
    const stdout = JSON.stringify([{ sessionId: "abcdef12-0000-4000-8000-000000000001", status: "busy", name: "Synthetic name" }]);
    expect(parseClaudeAgentsJson(stdout, NOW, CLI_NAMES)[0]?.title).toBe("Synthetic name");
  });

  it("the provider defaults to generated labels too", async () => {
    const sessions = await harness({ run: async () => ({ stdout: fixture("busy-and-idle.txt"), exitCode: 0 }) }).poll();
    expect(sessions.map((s) => s.title)).toEqual(["Session 00000001", "Session 00000002"]);
    const named = await harness({ run: async () => ({ stdout: fixture("busy-and-idle.txt"), exitCode: 0 }), titlePolicy: "cli_name" }).poll();
    expect(named.map((s) => s.title)).toEqual(["Refactor billing module", "Fix flaky login test"]);
  });
});

describe("cleanText", () => {
  it("strips C1 controls, zero-width and bidi characters", () => {
    expect(cleanText("a\u0085b\u200bc\u202ed\u2066e\u2028f\ufeffg\u00adh", 100)).toBe("a b c d e f g h");
  });

  it("never splits a surrogate pair at the cap, and drops lone surrogates", () => {
    const capped = cleanText(`${"a".repeat(9)}\u{1F600}`, 10);
    expect(capped).toBe("a".repeat(9));
    expect(cleanText("x\ud800y\udc00z", 10)).toBe("xyz");
    // Result is always well-formed, so JSON.stringify produces no lone \\uD8xx escape.
    expect(JSON.stringify(cleanText(`\ud83d${"b".repeat(5)}`, 3))).toBe('"bbb"');
  });

  it("returns null for blank or non-string input", () => {
    expect(cleanText(" \u200b\u0000 ", 10)).toBeNull();
    expect(cleanText(42, 10)).toBeNull();
  });

  it("strips fillers, variation selectors, annotation marks and tag characters", () => {
    const invisible = [
      "\u034f", // combining grapheme joiner
      "\u115f", "\u1160", "\u3164", // Hangul fillers
      "\u17b4", "\u17b5", // Khmer inherent vowels
      "\ufe00", "\ufe0f", // variation selectors
      "\u{e0100}", "\u{e01ef}", // variation selectors supplement
      "\ufff9", "\ufffa", "\ufffb", // interlinear annotation
      "\u{e0000}", "\u{e0001}", "\u{e0041}", "\u{e007f}", // tags
    ];
    for (const ch of invisible) expect(cleanText(`a${ch}b`, 100)).toBe("a b");
    // ASCII smuggled as tag characters ("SECRET") disappears entirely.
    const smuggled = [..."SECRET"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(cleanText(`title${smuggled}`, 100)).toBe("title");
    expect(cleanText(smuggled, 100)).toBeNull();
    // Neighbours of the ranges, and ordinary astral characters, are kept.
    expect(cleanText("\ufe10\u{e0080}\u{1F600}", 100)).toBe("\ufe10\u{e0080}\u{1F600}");
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

  it.each([
    ["D:\\Profiles\\jdoe", "jdoe"],
    ["D:\\Profiles\\JDoe", "jdoe"],
    ["/srv/homes/jdoe/", "JDOE"],
  ])("%s -> null when the last segment is the account name (%s)", (cwd, username) => {
    expect(projectLabelFromCwd(cwd, username)).toBeNull();
    expect(projectLabelFromCwd(cwd)).not.toBeNull(); // only the username check catches these
  });

  it("keeps labels that merely contain the account name, and works without one", () => {
    expect(projectLabelFromCwd("D:\\Profiles\\jdoe\\jdoe-tools", "jdoe")).toBe("jdoe-tools");
    expect(projectLabelFromCwd("D:\\Profiles\\jdoe", null)).toBe("jdoe");
    expect(projectLabelFromCwd("D:\\Profiles\\jdoe", "")).toBe("jdoe");
  });

  it("the parser drops a label equal to the injected username", () => {
    const stdout = JSON.stringify([{ sessionId: "00000000-0000-4000-8000-0000000000a1", status: "idle", cwd: "D:\\Profiles\\jdoe" }]);
    expect(parseClaudeAgentsJson(stdout, NOW, { username: "JDOE" })[0]?.project_label).toBeNull();
    expect(parseClaudeAgentsJson(stdout, NOW, { username: null })[0]?.project_label).toBe("jdoe");
  });

  it("localUsername never throws", () => {
    const name = localUsername();
    expect(name === null || (typeof name === "string" && name.length > 0)).toBe(true);
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

  it("returns parsed sessions and logs skipped duplicates without content", async () => {
    const logs: string[] = [];
    const p = provider(async () => ({ stdout: DUPLICATES, exitCode: 0 }), logs);
    expect(await p.poll()).toHaveLength(2);
    expect(logs).toEqual(["claude-code: skipped 1 malformed or duplicate session entry."]);
  });

  it("rejects a read with an unidentifiable entry as invalid output", async () => {
    const err = await failure(provider(async () => ({ stdout: fixture("malformed-entry.txt"), exitCode: 0 })));
    expect(err).toMatchObject({ kind: "unidentified_entries", category: "invalid_output" });
    for (const leak of ["Write migration", "zeta", "/home/dev"]) expect(err.message).not.toContain(leak);
  });

  it("rejects on a non-zero exit without leaking stdout", async () => {
    const p = provider(async () => ({ stdout: fixture("non-json.txt"), exitCode: 2 }));
    await expect(p.poll()).rejects.toThrow("claude agents --json exited with code 2.");
  });

  it.each([
    ["non-json.txt", "invalid_json"],
    ["empty.txt", "empty_output"],
    ["truncated.txt", "invalid_json"],
    ["renamed-keys.txt", "unrecognised_entries"],
  ])("rejects on unparseable output (%s) without leaking it", async (name, kind) => {
    const err = await failure(provider(async () => ({ stdout: fixture(name), exitCode: 0 })));
    expect(err.kind).toBe(kind);
    expect(err.category).toBe("invalid_output");
    expect(err.message).not.toContain("SYNTHETIC-SECRET-MARKER");
    expect(err.message).not.toContain("/home/dev");
  });

  it("never parses the partial stdout of an interrupted run", async () => {
    const err = await failure(provider(async () => ({ stdout: fixture("busy-and-idle.txt"), exitCode: -1, interrupted: true })));
    expect(err.kind).toBe("interrupted");
    expect(err.category).toBe("interrupted");
  });

  it("reports auth_required when the runner classified the failure that way", async () => {
    const err = await failure(provider(async () => ({ stdout: "", exitCode: 1, authRequired: true })));
    expect(err).toMatchObject({ kind: "auth_required", category: "auth_required" });
    expect(err.message).toMatch(/not signed in/);
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

  it.each([
    ["not_found", "cli_missing"],
    ["batch_shim", "cli_missing"],
    ["not_executable", "cli_missing"],
    ["timeout", "timeout"],
    ["output_too_large", "invalid_output"],
  ] as const)("keeps the %s kind and its %s category", async (kind, category) => {
    const err = await failure(
      provider(async () => {
        throw new ClaudeCommandError(kind);
      }),
    );
    expect(err).toMatchObject({ kind, category });
  });
});

describe("ClaudeCodeProvider version gate", () => {
  const listing = async (): Promise<CommandResult> => ({ stdout: fixture("busy-and-idle.txt"), exitCode: 0 });

  it.each([
    ["v24.19.0\n", "version_unrecognised"], // another program called `claude` (e.g. node)
    ["claude 2.1.312\n", "version_unrecognised"],
    ["2.1.312\n", "version_unrecognised"],
    ["2.1.312 (Claude Code)\nupdate available: SYNTHETIC-SECRET-MARKER\n", "version_unrecognised"],
    ["", "version_unrecognised"],
    ["1.0.17 (Claude Code)\n", "version_too_old"],
    ["2.1.311 (Claude Code)\n", "version_too_old"],
    ["3.0.0 (Claude Code)\n", "version_too_new"],
  ])("refuses %j (%s) before reading sessions", async (stdout, kind) => {
    let agentsCalls = 0;
    const err = await failure(
      harness({
        version: async () => ({ stdout, exitCode: 0 }),
        run: async () => {
          agentsCalls += 1;
          return listing();
        },
      }),
    );
    expect(err.kind).toBe(kind);
    expect(err.category).toBe("incompatible_version");
    expect(err.message).not.toContain("SYNTHETIC-SECRET-MARKER");
    expect(agentsCalls).toBe(0);
  });

  it("names the rebuilt version and our bound, never raw output", async () => {
    const err = await failure(harness({ version: async () => ({ stdout: "0002.0001.0005 (Claude Code)", exitCode: 0 }) }));
    expect(err.message).toBe("Claude Code 2.1.5 is older than the minimum supported version 2.1.312.");
  });

  it("accepts newer versions in the same major and logs that once", async () => {
    const logs: string[] = [];
    let now = NOW.getTime();
    const p = harness({ version: async () => ({ stdout: "2.4.0 (Claude Code)", exitCode: 0 }), run: listing, logs, now: () => new Date(now) });
    expect(await p.poll()).toHaveLength(2);
    now += VERSION_RECHECK_MS;
    await p.poll();
    expect(logs.filter((l) => l.includes("2.4.0"))).toHaveLength(1);
  });

  it("maps version-command failures with version wording", async () => {
    const err = await failure(harness({ version: async () => ({ stdout: "", exitCode: 127 }) }));
    expect(err.message).toBe("claude --version exited with code 127.");
    const thrown = await failure(
      harness({
        version: async () => {
          throw new Error("SYNTHETIC-SECRET-MARKER");
        },
      }),
    );
    expect(thrown.message).toBe("claude --version could not be started.");
  });

  it("checks the version once per interval while healthy, and again after any failure", async () => {
    let versionCalls = 0;
    let now = NOW.getTime();
    let agents: () => Promise<CommandResult> = listing;
    const p = harness({
      version: async () => {
        versionCalls += 1;
        return SYNTHETIC_VERSION;
      },
      run: () => agents(),
      now: () => new Date(now),
    });
    await p.poll();
    await p.poll();
    expect(versionCalls).toBe(1);
    now += VERSION_RECHECK_MS;
    await p.poll();
    expect(versionCalls).toBe(2);

    agents = async () => {
      throw new ClaudeCommandError("timeout");
    };
    await expect(p.poll()).rejects.toThrow(/timed out/);
    agents = listing;
    await p.poll();
    expect(versionCalls).toBe(3);
  });
});

describe("ClaudeCodeProvider recovery", () => {
  it("recovers on the next poll after transient failures of each category", async () => {
    const outcomes: (() => Promise<CommandResult>)[] = [
      async () => {
        throw new ClaudeCommandError("not_found");
      },
      async () => {
        throw new ClaudeCommandError("timeout");
      },
      async () => ({ stdout: fixture("truncated.txt"), exitCode: 0 }),
      async () => ({ stdout: "", exitCode: 1, authRequired: true }),
      async () => ({ stdout: "", exitCode: -1, interrupted: true }),
      async () => ({ stdout: fixture("busy-and-idle.txt"), exitCode: 0 }),
    ];
    let i = 0;
    const p = harness({
      run: () => {
        const next = outcomes[i++];
        if (!next) throw new Error("no scripted outcome left");
        return next();
      },
    });
    const categories: string[] = [];
    for (let n = 0; n < 5; n += 1) categories.push((await failure(p)).category);
    expect(categories).toEqual(["cli_missing", "timeout", "invalid_output", "auth_required", "interrupted"]);
    expect((await p.poll()).map((s) => s.status)).toEqual(["running", "waiting_for_input"]);
  });
});

describe("diagnose", () => {
  it("reports counts, version and policy, and never titles, ids or paths", async () => {
    const p = harness({ run: async () => ({ stdout: DUPLICATES, exitCode: 0 }), titlePolicy: "cli_name" });
    const d = await p.diagnose();
    expect(d).toEqual({
      ok: true,
      version: "2.1.312",
      compatibility: "supported",
      failure: null,
      sessions: 2,
      skipped: 1,
      byStatus: { running: 1, waiting_for_input: 1 },
      titlePolicy: "cli_name",
    });
    const text = formatClaudeCodeDiagnosis(d).join("\n");
    expect(text).toContain("running=1 waiting_for_input=1");
    for (const leak of ["Write migration", "epsilon", "/home/dev", "00000000-0000"]) expect(text).not.toContain(leak);
  });

  it("returns the failure category instead of throwing", async () => {
    const d = await harness({ version: async () => ({ stdout: "v24.19.0", exitCode: 0 }) }).diagnose();
    expect(d).toMatchObject({ ok: false, version: null, failure: { kind: "version_unrecognised", category: "incompatible_version" } });
    expect(formatClaudeCodeDiagnosis(d).at(-1)).toMatch(/^claude-code: FAILED \[incompatible_version\]/);
  });
});
