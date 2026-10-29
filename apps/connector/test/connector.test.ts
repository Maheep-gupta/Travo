import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Connector, MAX_BACKOFF_MS, backoffDelay } from "../src/connector.js";
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
  async poll() {
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
  const transport = new MemoryTransport(opts.backendUrl);
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

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelay(1, 1000, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(backoffDelay(4, 1000, () => 0.999)).toBe(7992);
    expect(backoffDelay(50, 1000, () => 0.999)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    expect(backoffDelay(3, 1000, () => 0)).toBe(1000);
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
