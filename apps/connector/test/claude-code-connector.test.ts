import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Connector } from "../src/connector.js";
import { ClaudeCodeProvider, ClaudeCommandError, type CommandResult } from "../src/providers/claude-code.js";
import { MemoryTransport } from "../src/transports/memory.js";

/*
 * The Claude Code provider driven through the real Connector and the
 * in-memory transport, with SYNTHETIC runner output (fixtures/claude-agents).
 * No process is spawned and nothing here proves real-CLI behaviour.
 */

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/claude-agents/${name}`, import.meta.url), "utf8");
}

const ONE = "00000000-0000-4000-8000-000000000001";
const TWO = "00000000-0000-4000-8000-000000000002";
const VERSION_OK: CommandResult = { stdout: "2.1.312 (Claude Code)\n", exitCode: 0 };

function setup(transport = new MemoryTransport("memory://local", () => new Date(clock.t))) {
  let agents: () => Promise<CommandResult> = async () => ({ stdout: fixture("busy-and-idle.txt"), exitCode: 0 });
  let version: () => Promise<CommandResult> = async () => VERSION_OK;
  const logs: string[] = [];
  const provider = new ClaudeCodeProvider({
    runCommand: () => agents(),
    runVersion: () => version(),
    titlePolicy: "cli_name",
    now: () => new Date(clock.t),
  });
  const connector = new Connector({
    provider,
    transport,
    platform: "test",
    version: "t",
    remoteControlAllowed: false,
    syncTranscripts: false,
    pollMs: 1000,
    log: (l) => logs.push(l),
    now: () => new Date(clock.t),
  });
  return {
    transport,
    connector,
    logs,
    set: (run: () => Promise<CommandResult>) => (agents = run),
    setVersion: (run: () => Promise<CommandResult>) => (version = run),
    status: (id: string) => transport.sessions.get(`claude-code:${id}`)?.status,
  };
}

const clock = { t: Date.parse("2026-10-29T12:00:00Z") };
const advance = (ms: number) => (clock.t += ms);

describe("Claude Code provider through the connector", () => {
  it("maps the lifecycle, and a session that disappears becomes ended, never completed", async () => {
    const { transport, connector, set, status } = setup();
    await connector.runOnce();
    expect([status(ONE), status(TWO)]).toEqual(["running", "waiting_for_input"]);
    expect(transport.sessions.get(`claude-code:${ONE}`)).toMatchObject({ is_demo: false, status_source: "cli_agents_list" });

    // ONE is no longer listed.
    set(async () => ({ stdout: JSON.stringify([{ sessionId: TWO, status: "busy" }]), exitCode: 0 }));
    advance(5000);
    await connector.runOnce();
    expect(status(ONE)).toBe("ended");
    expect(transport.sessions.get(`claude-code:${ONE}`)).toMatchObject({ status_source: "derived" });
    expect(status(TWO)).toBe("running");
    expect(JSON.stringify([...transport.sessions.values(), ...transport.events])).not.toContain("completed");
  });

  it.each([
    ["CLI missing", async () => Promise.reject(new ClaudeCommandError("not_found")), "not found", "cli_missing"],
    ["timeout", async () => Promise.reject(new ClaudeCommandError("timeout")), "timed out", "timeout"],
    ["auth required", async () => ({ stdout: "", exitCode: 1, authRequired: true }), "not signed in", "auth_required"],
    ["interrupted", async () => ({ stdout: fixture("truncated.txt"), exitCode: -1, interrupted: true }), "interrupted", "interrupted"],
    ["partial JSON", async () => ({ stdout: fixture("truncated.txt"), exitCode: 0 }), "not valid JSON", "invalid_output"],
    ["renamed format", async () => ({ stdout: fixture("renamed-keys.txt"), exitCode: 0 }), "unrecognised format", "invalid_output"],
    ["empty output", async () => ({ stdout: "", exitCode: 0 }), "no output", "invalid_output"],
    ["non-zero exit", async () => ({ stdout: fixture("non-json.txt"), exitCode: 2 }), "exited with code 2", "failed"],
    // TWO is still there, but its entry can't be identified: missing data, not negative evidence.
    [
      "a known session's entry without a usable id",
      async () => ({ stdout: JSON.stringify([{ sessionId: ONE, status: "busy" }, { sessionId: 42, status: "idle", cwd: "/home/dev/projects/beta" }]), exitCode: 0 }),
      "without a usable session id",
      "invalid_output",
    ],
  ] as const)("a failed read (%s) reports the source unhealthy, says which, and ends nothing", async (_, run, said, category) => {
    const { transport, connector, logs, set, status } = setup();
    await connector.runOnce();
    set(run as () => Promise<CommandResult>);
    advance(5000);
    await connector.runOnce();
    expect(connector.connectionState).toBe("provider_error");
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true, false]);
    // Only the category reaches the backend (schema v4), never the message.
    expect(transport.heartbeats.map((h) => h.provider_error_kind)).toEqual([null, category]);
    for (const h of transport.heartbeats) expect(Object.keys(h).sort()).toEqual(["connector_version", "platform", "provider_error_kind", "provider_ok", "remote_control_allowed"]);
    expect(logs.find((l) => l.startsWith("provider error: claude-code:"))).toContain(said);
    expect([status(ONE), status(TWO)]).toEqual(["running", "waiting_for_input"]);
    expect(transport.events.filter((e) => e.type === "session_ended")).toHaveLength(0);
    for (const l of logs) expect(l).not.toMatch(/SYNTHETIC-SECRET-MARKER|\/home\/dev|Refactor billing/);

    // Recovery after the transient failure.
    set(async () => ({ stdout: fixture("busy-and-idle.txt"), exitCode: 0 }));
    advance(5000);
    await connector.runOnce();
    expect(connector.connectionState).toBe("online");
    expect(transport.heartbeats.at(-1)?.provider_ok).toBe(true);
    expect(transport.events.filter((e) => e.type === "session_discovered")).toHaveLength(2);
  });

  it("an incompatible CLI after an update stops syncing without ending sessions, and recovers", async () => {
    const { transport, connector, logs, setVersion, status } = setup();
    await connector.runOnce();
    // The 10-minute recheck sees a new major version.
    setVersion(async () => ({ stdout: "3.0.0 (Claude Code)", exitCode: 0 }));
    advance(10 * 60_000);
    await connector.runOnce();
    expect(connector.connectionState).toBe("provider_error");
    expect(logs.find((l) => l.startsWith("provider error: claude-code:"))).toContain("newer than the supported range");
    expect(transport.heartbeats.at(-1)?.provider_ok).toBe(false);
    expect(transport.heartbeats.at(-1)?.provider_error_kind).toBe("incompatible_version");
    expect([status(ONE), status(TWO)]).toEqual(["running", "waiting_for_input"]);

    setVersion(async () => VERSION_OK);
    advance(5000);
    await connector.runOnce();
    expect(connector.connectionState).toBe("online");
    expect(transport.heartbeats.at(-1)?.provider_ok).toBe(true);
  });

  it("keeps session identity across a connector restart", async () => {
    const first = setup();
    await first.connector.runOnce();
    const ids = [...first.transport.sessions.values()].map((s) => s.id).sort();

    const second = setup(first.transport);
    advance(5000);
    await second.connector.runOnce();
    expect([...second.transport.sessions.values()].map((s) => s.id).sort()).toEqual(ids);
    // No second "discovered" event for the same sessions.
    expect(second.transport.events.filter((e) => e.type === "session_discovered")).toHaveLength(2);
  });
});
