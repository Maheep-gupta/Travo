import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSERVED_AT_MAX_SKEW_MS, type SessionUpsert } from "@mc/contracts";
import { describe, expect, it } from "vitest";
import { Connector, MAX_BACKOFF_MS, SKIPPED_WRITES_LIMIT, backoffDelay } from "../src/connector.js";
import { loadConfig } from "../src/config.js";
import { loadCredentials } from "../src/credentials.js";
import { pairHost } from "../src/pairing.js";
import { readRemoteControlPolicy } from "../src/policy.js";
import { MemoryTransport } from "../src/transports/memory.js";
import type { Provider, ProviderMessage, ProviderSession } from "../src/types.js";

class ScriptedProvider implements Provider {
  readonly id = "mock" as const;
  readonly isDemo = true;
  current: ProviderSession[] = [];
  failWith: Error | null = null;
  async poll() {
    if (this.failWith) throw this.failWith;
    return this.current.map((s) => ({ ...s }));
  }
  async messages(externalId: string): Promise<ProviderMessage[]> {
    return [{ external_uuid: `${externalId}-1`, role: "assistant", text: "(demo) hello", occurred_at: null }];
  }
}

function session(external_id: string, status: ProviderSession["status"]): ProviderSession {
  return {
    external_id,
    title: external_id,
    project_label: "p",
    status,
    status_reason: "Simulated",
    last_activity_at: null,
    last_event_summary: null,
    started_at: null,
  };
}

function setup(opts: { backendUrl?: string; syncTranscripts?: boolean } = {}) {
  let t = Date.parse("2026-10-29T12:00:00Z");
  const provider = new ScriptedProvider();
  const transport = new MemoryTransport(opts.backendUrl, () => new Date(t));
  const logs: string[] = [];
  const connector = new Connector({
    provider,
    transport,
    platform: "test",
    version: "t",
    remoteControlAllowed: false,
    syncTranscripts: opts.syncTranscripts ?? false,
    pollMs: 1000,
    log: (l) => logs.push(l),
    now: () => new Date(t),
  });
  return { provider, transport, connector, logs, advance: (ms: number) => (t += ms) };
}

describe("Connector", () => {
  it("records discovery and status changes once", async () => {
    const { provider, transport, connector, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    advance(1000);
    await connector.runOnce(); // no change
    provider.current = [session("a", "waiting_for_input")];
    advance(1000);
    await connector.runOnce();
    expect(transport.events.map((e) => `${e.type}:${e.status}`)).toEqual(["session_discovered:running", "status_changed:waiting_for_input"]);
    expect(connector.connectionState).toBe("online");
  });

  it("heartbeats at most every 30s", async () => {
    const { provider, transport, connector, advance } = setup();
    provider.current = [];
    for (let i = 0; i < 10; i++) {
      await connector.runOnce();
      advance(5000);
    }
    expect(transport.heartbeats).toHaveLength(2); // t=0 and t=30s... (45s elapsed)
    expect(transport.heartbeats[0]?.remote_control_allowed).toBe(false);
  });

  it("goes offline, backs off, and catches up on reconnect without duplicates", async () => {
    const { provider, transport, connector, logs, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    transport.available = false;
    provider.current = [session("a", "approval_required")];
    advance(1000);
    const d1 = await connector.runOnce();
    advance(d1);
    await connector.runOnce();
    expect(connector.connectionState).toBe("offline");
    expect(logs.filter((l) => l.startsWith("offline"))).toHaveLength(1);

    transport.available = true;
    advance(5000);
    expect(await connector.runOnce()).toBe(1000);
    expect(connector.connectionState).toBe("online");
    expect(logs.at(-1)).toMatch(/^online: .* after \d+s offline$/);
    // The missed change is recorded exactly once, and a heartbeat is sent immediately.
    expect(transport.events.filter((e) => e.status === "approval_required")).toHaveLength(1);
    expect(transport.heartbeats).toHaveLength(2);
    advance(1000);
    await connector.runOnce();
    expect(transport.events.filter((e) => e.status === "approval_required")).toHaveLength(1);
  });

  it("reports a failing provider separately from the backend, without ending sessions", async () => {
    const { provider, transport, connector, logs, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    provider.failWith = new Error("claude agents --json timed out.");
    for (let i = 0; i < 4; i++) {
      advance(15_000);
      await connector.runOnce();
    }
    expect(connector.connectionState).toBe("provider_error");
    expect(logs.filter((l) => l.startsWith("provider error: mock: claude agents --json timed out."))).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("offline"))).toBe(false);
    // Health is reported at once when it changes (t=15s), then on the normal schedule (t=45s),
    // so the host stays online while the dashboard stops trusting its statuses.
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true, false, false]);
    // A failed read is not "no sessions": nothing is ended.
    expect(transport.events.filter((e) => e.type === "session_ended")).toHaveLength(0);
    expect(transport.sessions.get("mock:a")?.status).toBe("running");

    provider.failWith = null;
    provider.current = [session("a", "waiting_for_input")];
    advance(5000);
    expect(await connector.runOnce()).toBe(1000);
    expect(connector.connectionState).toBe("online");
    expect(logs.at(-1)).toMatch(/^provider recovered: mock after \d+s$/);
    // Recovery is reported immediately, not at the next scheduled heartbeat.
    expect(transport.heartbeats.at(-1)?.provider_ok).toBe(true);
    expect(transport.events.map((e) => `${e.type}:${e.status}`)).toEqual(["session_discovered:running", "status_changed:waiting_for_input"]);
  });

  it("backs off while the provider keeps failing", async () => {
    const { provider, connector } = setup();
    provider.failWith = new Error("not found");
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) delays.push(await connector.runOnce());
    expect(delays.every((d) => d >= 1000 && d <= MAX_BACKOFF_MS)).toBe(true);
  });

  it("still reports backend loss as offline even when the provider is fine", async () => {
    const { transport, connector } = setup();
    transport.available = false;
    await connector.runOnce();
    expect(connector.connectionState).toBe("offline");
  });

  it("marks disappeared sessions as ended, not completed", async () => {
    const { provider, transport, connector, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    provider.current = [];
    advance(1000);
    await connector.runOnce();
    const row = [...transport.sessions.values()].find((s) => s.external_id === "a");
    expect(row?.status).toBe("ended");
    expect(row?.status_source).toBe("derived");
    expect(transport.events.at(-1)?.type).toBe("session_ended");
  });

  it("does not let a delayed older write regress a newer status (schema v3)", async () => {
    // Two overlapping connector processes for one host, e.g. during a restart.
    // The stale one's clock is 10s behind, so its writes carry older observations.
    const transport = new MemoryTransport("memory://local", () => new Date("2026-10-29T12:00:10Z"));
    const make = (provider: ScriptedProvider, at: () => number, logs: string[]) =>
      new Connector({ provider, transport, platform: "test", version: "t", remoteControlAllowed: false, syncTranscripts: false, pollMs: 1000, log: (l) => logs.push(l), now: () => new Date(at()) });
    let tFresh = Date.parse("2026-10-29T12:00:10Z");
    let tStale = Date.parse("2026-10-29T12:00:00Z");
    const fresh = new ScriptedProvider();
    const stale = new ScriptedProvider();
    const staleLogs: string[] = [];
    const freshConnector = make(fresh, () => tFresh, []);
    const staleConnector = make(stale, () => tStale, staleLogs);

    fresh.current = [session("a", "running")];
    await freshConnector.runOnce();
    fresh.current = [session("a", "approval_required")];
    tFresh += 1000;
    await freshConnector.runOnce();

    stale.current = [session("a", "running")];
    expect(await staleConnector.runOnce()).toBe(1000);
    const row = transport.sessions.get("mock:a");
    expect(row?.status).toBe("approval_required");
    expect(row?.observed_at).toBe("2026-10-29T12:00:11.000Z");
    // Skipped silently: no event for the stale observation, and the batch and health stay fine.
    expect(transport.events.map((e) => `${e.type}:${e.status}`)).toEqual(["session_discovered:running", "status_changed:approval_required"]);
    expect(staleConnector.connectionState).toBe("online");
    expect(staleLogs.some((l) => l.startsWith("offline"))).toBe(false);

    // Once its observations are newer, the same connector's writes win again.
    stale.current = [session("a", "waiting_for_input")];
    tStale += 20_000;
    await staleConnector.runOnce();
    expect(transport.sessions.get("mock:a")?.status).toBe("waiting_for_input");
    expect(transport.events.at(-1)?.status).toBe("waiting_for_input");
  });

  it("retries a skipped 'ended' write instead of assuming it landed", async () => {
    const { provider, transport, connector, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    // Another writer stored a newer observation for "a" in the meantime.
    const stored = transport.sessions.get("mock:a");
    if (!stored) throw new Error("missing row");
    transport.sessions.set("mock:a", { ...stored, status: "waiting_for_input", observed_at: "2026-10-29T12:00:05.000Z" });

    provider.current = [];
    advance(1000); // t=1s: older than the stored observation, so skipped
    await connector.runOnce();
    expect(transport.sessions.get("mock:a")?.status).toBe("waiting_for_input");
    expect(transport.events.filter((e) => e.type === "session_ended")).toHaveLength(0);

    advance(5000); // t=6s: newer, so the end is recorded exactly once
    await connector.runOnce();
    expect(transport.sessions.get("mock:a")?.status).toBe("ended");
    advance(1000);
    await connector.runOnce();
    expect(transport.events.filter((e) => e.type === "session_ended")).toHaveLength(1);
  });

  it("never grants control capabilities", async () => {
    const { provider, transport, connector } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    const caps = [...transport.sessions.values()][0]?.capabilities ?? [];
    expect(caps).not.toContain("send_message");
    expect(caps).not.toContain("approve_requests");
  });

  it("only writes transcript content to a loopback backend when opted in", async () => {
    for (const [url, optIn, expected] of [
      ["https://abc.supabase.co", true, 0],
      ["http://127.0.0.1:54321", false, 0],
      ["http://127.0.0.1:54321", true, 1],
    ] as const) {
      const { provider, transport, connector } = setup({ backendUrl: url, syncTranscripts: optIn });
      provider.current = [session("a", "running")];
      await connector.runOnce();
      expect(transport.messages).toHaveLength(expected);
    }
  });
});

describe("Connector with a clock behind the backend's stored observations", () => {
  it("reports the source as not responding while its writes keep being skipped, and recovers", async () => {
    const { provider, transport, connector, logs, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    // Another writer (or this machine before its clock stepped back) stored a far newer observation.
    const stored = transport.sessions.get("mock:a");
    if (!stored) throw new Error("missing row");
    transport.sessions.set("mock:a", { ...stored, observed_at: "2026-10-29T13:00:00.000Z" });

    for (let i = 0; i < SKIPPED_WRITES_LIMIT; i++) {
      advance(1000);
      await connector.runOnce();
    }
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true]);
    advance(1000);
    await connector.runOnce(); // health changed: heartbeat sent at once
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true, false]);
    expect(logs.some((l) => l.includes("reporting the source as not responding"))).toBe(true);
    expect(connector.connectionState).toBe("online"); // the backend itself is fine

    // Writes land again (e.g. the other writer stopped and time caught up).
    transport.sessions.set("mock:a", { ...stored, observed_at: "2026-10-29T12:00:00.000Z" });
    advance(1000);
    await connector.runOnce(); // accepted: counter resets
    advance(1000);
    await connector.runOnce();
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true, false, true]);
    expect(logs).toContain("session writes accepted again");
  });

  it("treats writes that keep failing after a good heartbeat the same way", async () => {
    const { provider, transport, connector, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    const upsert = transport.upsertSessions.bind(transport);
    transport.upsertSessions = async () => {
      throw new Error("upsert sessions failed (42501)");
    };
    // The first failure precedes any heartbeat that cycle; later cycles heartbeat (forced after a failure) then fail.
    for (let i = 0; i < SKIPPED_WRITES_LIMIT + 2; i++) {
      advance(1000);
      await connector.runOnce();
    }
    expect(transport.heartbeats.map((h) => h.provider_ok).at(-1)).toBe(false);
    transport.upsertSessions = upsert;
    advance(1000);
    await connector.runOnce();
    advance(1000);
    await connector.runOnce();
    expect(transport.heartbeats.map((h) => h.provider_ok).at(-1)).toBe(true);
  });

  it("doesn't count a full backend outage against the source", async () => {
    const { provider, transport, connector, advance } = setup();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    transport.available = false;
    for (let i = 0; i < SKIPPED_WRITES_LIMIT + 2; i++) {
      advance(1000);
      await connector.runOnce();
    }
    transport.available = true;
    advance(1000);
    await connector.runOnce();
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true, true]);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelay(1, 1000, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(backoffDelay(4, 1000, () => 0.999)).toBe(7992);
    expect(backoffDelay(50, 1000, () => 0.999)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    expect(backoffDelay(3, 1000, () => 0)).toBe(1000);
  });
});

describe("MemoryTransport stale-write guard (mirrors schema v3)", () => {
  const dbNow = new Date("2026-10-29T12:00:00Z");
  const row = (status: SessionUpsert["status"], observed_at: string): SessionUpsert => ({
    provider: "mock",
    external_id: "a",
    title: "a",
    project_label: null,
    status,
    status_reason: null,
    status_source: "mock",
    last_activity_at: null,
    last_event_summary: null,
    capabilities: ["discover"],
    is_demo: true,
    started_at: null,
    ended_at: null,
    observed_at,
  });

  it("keeps the newer observation, applies equal ones idempotently", async () => {
    const t = new MemoryTransport("memory://local", () => dbNow);
    const id = (await t.upsertSessions([row("running", "2026-10-29T11:59:50.000Z")])).get("a");
    expect(id).toBeDefined();
    expect((await t.upsertSessions([row("failed", "2026-10-29T11:59:40.000Z")])).has("a")).toBe(false); // older: skipped
    expect(t.sessions.get("mock:a")?.status).toBe("running");
    expect((await t.upsertSessions([row("running", "2026-10-29T11:59:50.000Z")])).get("a")).toBe(id); // equal: same result
    expect(t.sessions.get("mock:a")?.status).toBe("running");
    await t.upsertSessions([row("completed", "2026-10-29T11:59:55.000Z")]); // newer wins
    expect(t.sessions.get("mock:a")?.status).toBe("completed");
    expect(t.sessions.size).toBe(1);
  });

  it("clamps far-future observations so a fast clock cannot pin a session", async () => {
    const t = new MemoryTransport("memory://local", () => dbNow);
    await t.upsertSessions([row("running", "2027-01-01T00:00:00.000Z")]);
    expect(t.sessions.get("mock:a")?.observed_at).toBe(new Date(dbNow.getTime() + OBSERVED_AT_MAX_SKEW_MS).toISOString());
    // A correct clock catches up after at most the skew window.
    expect((await t.upsertSessions([row("failed", "2026-10-29T12:04:00.000Z")])).has("a")).toBe(false);
    expect((await t.upsertSessions([row("failed", "2026-10-29T12:05:00.000Z")])).has("a")).toBe(true);
    expect(t.sessions.get("mock:a")?.status).toBe("failed");
  });

  it("rejects the whole batch when an observation time is missing", async () => {
    const t = new MemoryTransport("memory://local", () => dbNow);
    await expect(t.upsertSessions([row("running", "2026-10-29T11:59:50.000Z"), row("running", "")])).rejects.toThrow(/23502/);
    expect(t.sessions.size).toBe(0);
  });
});

describe("config", () => {
  it("keeps the real adapter disabled", () => {
    expect(() => loadConfig({ MC_PROVIDER: "claude-code" })).toThrow(/disabled/);
    expect(loadConfig({}).MC_PROVIDER).toBe("mock");
  });
  it("rejects secret keys and insecure URLs", () => {
    expect(() => loadConfig({ MC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_abcdefghijklmnopqrstuvwxyz" })).toThrow(/secret/);
    expect(() => loadConfig({ MC_SUPABASE_URL: "http://example.com" })).toThrow(/https/);
  });
});

describe("pairing", () => {
  it("stores credentials on success and never returns the password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-pair-"));
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ host_id: "11111111-1111-4111-8111-111111111111", email: "h@x.invalid", password: "p".repeat(40) }), {
        status: 200,
      })) as typeof fetch;
    const r = await pairHost({ url: "http://127.0.0.1:54321", publishableKey: "k", code: "abcd-efgh-jklm", platform: "t", version: "t", dataDir: dir, fetchImpl: fakeFetch });
    expect(r).not.toHaveProperty("password");
    expect((await loadCredentials(dir))?.host_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("reports failures without storing anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-pair-"));
    const fakeFetch = (async () => new Response(JSON.stringify({ error: "invalid_or_expired_code" }), { status: 400 })) as typeof fetch;
    await expect(
      pairHost({ url: "http://127.0.0.1:54321", publishableKey: "k", code: "ABCD-EFGH-JKLM", platform: "t", version: "t", dataDir: dir, fetchImpl: fakeFetch }),
    ).rejects.toThrow(/invalid_or_expired_code/);
    expect(await loadCredentials(dir)).toBeNull();
  });

  it("rejects malformed codes before any network call", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(
      pairHost({ url: "http://127.0.0.1:54321", publishableKey: "k", code: "nope", platform: "t", version: "t", dataDir: tmpdir(), fetchImpl: fakeFetch }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("readRemoteControlPolicy", () => {
  it("reads only the remote-control flag and treats anything else as unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-policy-"));
    const f = join(dir, "p.json");
    await writeFile(f, JSON.stringify({ restrictions: { allow_remote_control: { allowed: false } } }));
    expect(await readRemoteControlPolicy(f)).toBe(false);
    await writeFile(f, "{}");
    expect(await readRemoteControlPolicy(f)).toBeNull();
    expect(await readRemoteControlPolicy(join(dir, "missing.json"))).toBeNull();
    expect(JSON.parse(await readFile(f, "utf8"))).toEqual({});
  });
});
