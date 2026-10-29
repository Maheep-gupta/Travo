import { describe, expect, it } from "vitest";
import { ConnectionConfig, createDemoApi, isPrivilegedKey } from "../src/index.js";

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

describe("connection config", () => {
  it("rejects secret and service-role keys", () => {
    expect(isPrivilegedKey("sb_secret_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isPrivilegedKey(fakeJwt({ role: "service_role" }))).toBe(true);
    expect(isPrivilegedKey(fakeJwt({ role: "anon" }))).toBe(false);
    expect(isPrivilegedKey("sb_publishable_abcdefghijklmnopqrstuvwxyz")).toBe(false);
    const r = ConnectionConfig.safeParse({ url: "https://x.supabase.co", publishableKey: "sb_secret_abcdefghijklmnopqrstuvwxyz" });
    expect(r.success).toBe(false);
  });

  it("requires https except for loopback", () => {
    const key = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
    expect(ConnectionConfig.safeParse({ url: "http://example.com", publishableKey: key }).success).toBe(false);
    expect(ConnectionConfig.safeParse({ url: "http://127.0.0.1:54321", publishableKey: key }).success).toBe(true);
    expect(ConnectionConfig.safeParse({ url: "http://127.0.0.1.evil.com", publishableKey: key }).success).toBe(false);
    expect(ConnectionConfig.safeParse({ url: "https://abc.supabase.co", publishableKey: key }).success).toBe(true);
  });
});

describe("demo api", () => {
  it("marks everything as demo data from the mock provider", async () => {
    const api = createDemoApi({ tickMs: 0 });
    const sessions = await api.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) {
      expect(s.is_demo).toBe(true);
      expect(s.provider).toBe("mock");
      expect(s.capabilities).not.toContain("send_message");
    }
  });

  it("simulates host outages: no heartbeat while offline", async () => {
    let t = Date.parse("2026-10-29T12:00:00Z");
    const api = createDemoApi({ tickMs: 0, onlineMs: 60_000, offlineMs: 60_000, now: () => t });
    const first = (await api.listHosts()).find((h) => h.name === "Demo laptop");
    expect(first?.last_seen_at).toBe(new Date(t).toISOString());
    t += 90_000; // inside the offline window
    const during = (await api.listHosts()).find((h) => h.name === "Demo laptop");
    expect(during?.last_seen_at).toBe(first?.last_seen_at);
    t += 40_000; // reconnected
    const after = (await api.listHosts()).find((h) => h.name === "Demo laptop");
    expect(after?.last_seen_at).toBe(new Date(t).toISOString());
  });

  it("refuses pairing in demo mode and requires sign-in", async () => {
    const api = createDemoApi({ tickMs: 0 });
    await expect(api.createHostPairing("x")).rejects.toThrow(/demo mode/);
    await api.signOut();
    await expect(api.listSessions()).rejects.toThrow(/sign in/);
  });

  it("revocation is one-way", async () => {
    const api = createDemoApi({ tickMs: 0 });
    const [host] = await api.listHosts();
    if (!host) throw new Error("no host");
    await api.revokeHost(host.id);
    const revokedAt = (await api.listHosts()).find((h) => h.id === host.id)?.revoked_at;
    expect(revokedAt).toBeTruthy();
    await api.revokeHost(host.id);
    expect((await api.listHosts()).find((h) => h.id === host.id)?.revoked_at).toBe(revokedAt);
  });
});
