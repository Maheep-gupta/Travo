import { describe, expect, it } from "vitest";
import {
  checkSchemaCompat,
  compareByAttention,
  diffObservations,
  displayStatus,
  effectiveCapabilities,
  hostConnectivity,
  hostSourceOk,
  isLoopbackUrl,
  isSessionSort,
  mapClaudeAgentsStatus,
  matchesFilter,
  relativeTime,
  sortSessions,
  summariseByHost,
  transcriptContentDecision,
  DISCONNECT_AFTER_MS,
  SESSION_SORTS,
  type SessionSort,
  type SortableSession,
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
    // Host reachable but its session source failing: never the stale stored status.
    expect(displayStatus("running", "online", false)).toBe("source_unavailable");
    expect(displayStatus("ended", "online", false)).toBe("ended");
    expect(displayStatus("running", "disconnected", false)).toBe("disconnected");
    expect(hostSourceOk({ provider_error_since: null })).toBe(true);
    expect(hostSourceOk({ provider_error_since: "2026-10-29T12:00:00Z" })).toBe(false);
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
  const base: SortableSession = {
    id: "s-0",
    displayStatus: "running",
    provider: "claude-code",
    host_id: "h-1",
    hostName: "Laptop",
    title: "Refactor billing",
    project_label: "OpkeyStack",
    last_event_summary: null,
    last_activity_at: ago(1000),
  };
  it("filters by status, provider, host, project and search text", () => {
    expect(matchesFilter(base, { statuses: ["running"] })).toBe(true);
    expect(matchesFilter(base, { statuses: ["failed"] })).toBe(false);
    expect(matchesFilter(base, { providers: ["mock"] })).toBe(false);
    expect(matchesFilter(base, { hostIds: ["h-1"] })).toBe(true);
    expect(matchesFilter(base, { hostIds: ["h-2"] })).toBe(false);
    expect(matchesFilter(base, { projects: ["OpkeyStack"] })).toBe(true);
    expect(matchesFilter(base, { projects: ["other"] })).toBe(false);
    expect(matchesFilter({ ...base, project_label: null }, { projects: ["OpkeyStack"] })).toBe(false);
    expect(matchesFilter(base, { query: "opkey" })).toBe(true);
    expect(matchesFilter(base, { query: "nothing" })).toBe(false);
    // Filters compose: every given field must match.
    expect(matchesFilter(base, { statuses: ["running"], hostIds: ["h-1"], projects: ["OpkeyStack"], query: "billing" })).toBe(true);
    expect(matchesFilter(base, { statuses: ["running"], hostIds: ["h-2"] })).toBe(false);
  });
  it("puts blocked sessions first, then most recent", () => {
    const list: SortableSession[] = [
      { ...base, id: "a", title: "old-running", last_activity_at: ago(60_000) },
      { ...base, id: "b", title: "approval", displayStatus: "approval_required", last_activity_at: ago(500_000) },
      { ...base, id: "c", title: "new-running", last_activity_at: ago(1_000) },
    ];
    expect(list.sort(compareByAttention).map((s) => s.title)).toEqual(["approval", "new-running", "old-running"]);
  });

  const list: SortableSession[] = [
    { ...base, id: "s-run", displayStatus: "running", hostName: "Beta", host_id: "h-2", project_label: "zeta", last_activity_at: ago(30_000) },
    { ...base, id: "s-done-old", displayStatus: "completed", hostName: "alpha", host_id: "h-1", project_label: null, last_activity_at: ago(90_000) },
    { ...base, id: "s-wait", displayStatus: "waiting_for_input", hostName: "alpha", host_id: "h-1", project_label: "Api", last_activity_at: ago(60_000) },
    { ...base, id: "s-done-new", displayStatus: "completed", hostName: "Beta", host_id: "h-2", project_label: "api", last_activity_at: ago(10_000) },
    { ...base, id: "s-ended", displayStatus: "ended", hostName: "alpha", host_id: "h-1", project_label: "zeta", last_activity_at: null },
  ];
  const order = (sort: SessionSort) => sortSessions(list, sort).map((s) => s.id);

  it("supports every spec sort order", () => {
    expect(order("attention")).toEqual(["s-wait", "s-done-new", "s-done-old", "s-run", "s-ended"]);
    expect(order("recent")).toEqual(["s-done-new", "s-run", "s-wait", "s-done-old", "s-ended"]);
    expect(order("working")).toEqual(["s-run", "s-wait", "s-done-new", "s-done-old", "s-ended"]);
    expect(order("completed")).toEqual(["s-done-new", "s-done-old", "s-ended", "s-run", "s-wait"]);
    // Host names compare case-insensitively ("alpha" before "Beta"); attention order within a host.
    expect(order("host")).toEqual(["s-wait", "s-done-old", "s-ended", "s-done-new", "s-run"]);
    // Sessions without a project go last.
    expect(order("project")).toEqual(["s-wait", "s-done-new", "s-run", "s-ended", "s-done-old"]);
  });

  it("does not mutate its input", () => {
    const before = list.map((s) => s.id);
    sortSessions(list, "recent");
    expect(list.map((s) => s.id)).toEqual(before);
  });

  it("is deterministic when timestamps and labels are equal", () => {
    const same: SortableSession[] = ["s-3", "s-1", "s-2"].map((id) => ({ ...base, id }));
    const reversed = [...same].reverse();
    for (const sort of Object.keys(SESSION_SORTS) as SessionSort[]) {
      expect(sortSessions(same, sort).map((s) => s.id), sort).toEqual(["s-1", "s-2", "s-3"]);
      expect(sortSessions(reversed, sort).map((s) => s.id), sort).toEqual(["s-1", "s-2", "s-3"]);
    }
  });

  it("recognises only known sort names", () => {
    expect(isSessionSort("recent")).toBe(true);
    expect(isSessionSort("toString")).toBe(false);
    expect(isSessionSort("")).toBe(false);
    expect(isSessionSort(null)).toBe(false);
  });
});

describe("summariseByHost", () => {
  it("counts sessions and keeps the latest activity per host", () => {
    const summary = summariseByHost([
      { host_id: "h-1", last_activity_at: ago(60_000) },
      { host_id: "h-1", last_activity_at: ago(5_000) },
      { host_id: "h-1", last_activity_at: null },
      { host_id: "h-2", last_activity_at: null },
    ]);
    expect(summary.get("h-1")).toEqual({ count: 3, lastActivityAt: ago(5_000) });
    expect(summary.get("h-2")).toEqual({ count: 1, lastActivityAt: null });
    expect(summary.has("h-3")).toBe(false);
  });
});

describe("schema compatibility", () => {
  it("rejects missing, older and newer schemas", () => {
    expect(checkSchemaCompat(null)).toMatchObject({ ok: false, reason: "not_installed" });
    expect(checkSchemaCompat(0)).toMatchObject({ ok: false, reason: "too_old" });
    expect(checkSchemaCompat(99)).toMatchObject({ ok: false, reason: "too_new" });
    // v2 (source health) is required: v1 lacks hosts.provider_error_since.
    expect(checkSchemaCompat(1)).toMatchObject({ ok: false, reason: "too_old" });
    expect(checkSchemaCompat(2)).toEqual({ ok: true });
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
