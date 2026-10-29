import { describe, expect, it } from "vitest";
import {
  checkSchemaCompat,
  compareByAttention,
  diffObservations,
  displayStatus,
  effectiveCapabilities,
  hostConnectivity,
  isLoopbackUrl,
  mapClaudeAgentsStatus,
  matchesFilter,
  relativeTime,
  transcriptContentDecision,
  DISCONNECT_AFTER_MS,
  type FilterableSession,
} from "../src/index.js";

const now = new Date("2026-10-29T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe("mapClaudeAgentsStatus", () => {
  it("maps observed values", () => {
    expect(mapClaudeAgentsStatus("busy").status).toBe("running");
    expect(mapClaudeAgentsStatus("idle").status).toBe("waiting_for_input");
  });
  it("never guesses on unrecognised values", () => {
    const r = mapClaudeAgentsStatus("something-new");
    expect(r.status).toBe("unknown");
    expect(r.reason).toContain("something-new");
    expect(mapClaudeAgentsStatus(undefined).status).toBe("unknown");
  });
});

describe("host connectivity", () => {
  it("is online within the threshold and disconnected after", () => {
    expect(hostConnectivity({ last_seen_at: ago(1000), revoked_at: null }, now)).toBe("online");
    expect(hostConnectivity({ last_seen_at: ago(DISCONNECT_AFTER_MS + 1), revoked_at: null }, now)).toBe("disconnected");
  });
  it("reports never-connected and revoked hosts", () => {
    expect(hostConnectivity({ last_seen_at: null, revoked_at: null }, now)).toBe("never_connected");
    expect(hostConnectivity({ last_seen_at: ago(0), revoked_at: ago(0) }, now)).toBe("revoked");
  });
  it("does not trust stored status while the host is offline", () => {
    expect(displayStatus("running", "disconnected")).toBe("disconnected");
    expect(displayStatus("waiting_for_input", "revoked")).toBe("disconnected");
    expect(displayStatus("ended", "disconnected")).toBe("ended");
    expect(displayStatus("running", "online")).toBe("running");
  });
});

describe("effectiveCapabilities", () => {
  it("never grants control capabilities when the org policy is false or unknown", () => {
    for (const remoteControlAllowed of [false, null]) {
      const caps = effectiveCapabilities("claude-code", { remoteControlAllowed, repliesEnabled: true });
      expect(caps).not.toContain("send_message");
      expect(caps).not.toContain("approve_requests");
    }
  });
  it("reports no capabilities for providers without a supported API", () => {
    const policy = { remoteControlAllowed: true, repliesEnabled: true };
    expect(effectiveCapabilities("claude-web", policy)).toEqual([]);
    expect(effectiveCapabilities("cowork", policy)).toEqual([]);
  });
  it("keeps read capabilities for Claude Code", () => {
    const caps = effectiveCapabilities("claude-code", { remoteControlAllowed: false, repliesEnabled: false });
    expect(caps).toEqual(expect.arrayContaining(["discover", "read_messages"]));
  });
});

describe("transcript content guard", () => {
  it("recognises loopback URLs only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackUrl("http://localhost:54321")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:54321")).toBe(true);
    expect(isLoopbackUrl("https://abc.supabase.co")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("http://user@127.0.0.1:54321/x")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1@evil.com/")).toBe(false);
    expect(isLoopbackUrl("http://evil.com/?h=127.0.0.1")).toBe(false);
  });
  it("requires opt-in and a loopback backend", () => {
    expect(transcriptContentDecision("http://127.0.0.1:54321", false).allowed).toBe(false);
    expect(transcriptContentDecision("https://abc.supabase.co", true).allowed).toBe(false);
    expect(transcriptContentDecision("http://127.0.0.1:54321", true).allowed).toBe(true);
  });
});

describe("diffObservations", () => {
  it("emits discovery, change and end events with deterministic dedupe keys", () => {
    const prev = new Map([
      ["a", "running" as const],
      ["b", "running" as const],
      ["gone", "waiting_for_input" as const],
    ]);
    const events = diffObservations(
      prev,
      [
        { external_id: "a", status: "running" },
        { external_id: "b", status: "waiting_for_input" },
        { external_id: "new", status: "running" },
      ],
      now,
    );
    expect(events).toEqual([
      { external_id: "b", type: "status_changed", status: "waiting_for_input", dedupe_key: `status:waiting_for_input:${now.toISOString()}` },
      { external_id: "new", type: "session_discovered", status: "running", dedupe_key: "discovered" },
      { external_id: "gone", type: "session_ended", status: "ended", dedupe_key: `ended:${now.toISOString()}` },
    ]);
    // Same input => same keys (retry-safe).
    expect(diffObservations(prev, [{ external_id: "b", status: "waiting_for_input" }], now)[0]?.dedupe_key).toBe(
      events[0]?.dedupe_key,
    );
  });
  it("does not re-end already ended sessions", () => {
    expect(diffObservations(new Map([["x", "ended" as const]]), [], now)).toEqual([]);
  });
});

describe("filtering and ordering", () => {
  const base: FilterableSession = {
    displayStatus: "running",
    provider: "claude-code",
    title: "Refactor billing",
    project_label: "OpkeyStack",
    last_event_summary: null,
    last_activity_at: ago(1000),
  };
  it("filters by status, provider and search text", () => {
    expect(matchesFilter(base, { statuses: ["running"] })).toBe(true);
    expect(matchesFilter(base, { statuses: ["failed"] })).toBe(false);
    expect(matchesFilter(base, { providers: ["mock"] })).toBe(false);
    expect(matchesFilter(base, { query: "opkey" })).toBe(true);
    expect(matchesFilter(base, { query: "nothing" })).toBe(false);
  });
  it("puts blocked sessions first, then most recent", () => {
    const list: FilterableSession[] = [
      { ...base, title: "old-running", last_activity_at: ago(60_000) },
      { ...base, title: "approval", displayStatus: "approval_required", last_activity_at: ago(500_000) },
      { ...base, title: "new-running", last_activity_at: ago(1_000) },
    ];
    expect(list.sort(compareByAttention).map((s) => s.title)).toEqual(["approval", "new-running", "old-running"]);
  });
});

describe("schema compatibility", () => {
  it("rejects missing, older and newer schemas", () => {
    expect(checkSchemaCompat(null)).toMatchObject({ ok: false, reason: "not_installed" });
    expect(checkSchemaCompat(0)).toMatchObject({ ok: false, reason: "too_old" });
    expect(checkSchemaCompat(99)).toMatchObject({ ok: false, reason: "too_new" });
    expect(checkSchemaCompat(1)).toEqual({ ok: true });
  });
});

describe("relativeTime", () => {
  it("formats", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(ago(10_000), now)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3600_000), now)).toBe("3h ago");
  });
});
