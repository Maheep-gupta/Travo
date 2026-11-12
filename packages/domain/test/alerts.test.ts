import { describe, expect, it } from "vitest";
import type { NotificationPrefs } from "@mc/contracts";
import {
  alertAllowed,
  alertNotificationText,
  detectAlerts,
  mergeAlerts,
  notificationName,
  parseStoredAlerts,
  unreadCount,
  MAX_NOTIFICATION_NAME_LENGTH,
  MAX_STORED_ALERTS,
  type AlertHostInput,
  type AlertSessionInput,
  type AlertSnapshot,
  type StoredAlert,
  type TavroAlert,
} from "../src/index.js";

const HOST = "h1";
const host = (over: Partial<AlertHostInput> = {}): AlertHostInput => ({
  id: HOST,
  connectivity: "online",
  last_seen_at: "2026-10-29T12:00:00.000Z",
  provider_error_since: null,
  is_demo: false,
  ...over,
});
const session = (over: Partial<AlertSessionInput> = {}): AlertSessionInput => ({
  id: "s1",
  host_id: HOST,
  status: "running",
  last_activity_at: "2026-10-29T12:00:00.000Z",
  updated_at: "2026-10-29T12:00:00.000Z",
  is_demo: false,
  ...over,
});

/** Runs detection over a sequence of observations, collecting every alert. */
function run(steps: { sessions: AlertSessionInput[]; hosts: AlertHostInput[] }[]): TavroAlert[] {
  let snap: AlertSnapshot | null = null;
  const all: TavroAlert[] = [];
  for (const step of steps) {
    const r = detectAlerts(snap, step.sessions, step.hosts);
    all.push(...r.alerts);
    snap = r.snapshot;
  }
  return all;
}

describe("detectAlerts", () => {
  it("treats the first observation as a baseline", () => {
    expect(run([{ sessions: [session({ status: "approval_required" })], hosts: [host()] }])).toEqual([]);
  });

  it("does not alert on states that existed behind a host that was offline at baseline", () => {
    const alerts = run([
      { sessions: [session({ id: "a", status: "approval_required" }), session({ id: "b", status: "failed" })], hosts: [host({ connectivity: "disconnected" })] },
      { sessions: [session({ id: "a", status: "approval_required" }), session({ id: "b", status: "failed" })], hosts: [host({ last_seen_at: "2026-10-29T12:05:00.000Z" })] },
    ]);
    expect(alerts.map((a) => a.kind)).toEqual(["host_reconnected"]);
  });

  it("does not alert on a session first seen behind an offline host whose status is unchanged when it returns", () => {
    const alerts = run([
      { sessions: [], hosts: [host()] },
      { sessions: [session({ status: "failed" })], hosts: [host({ connectivity: "disconnected" })] },
      { sessions: [session({ status: "failed" })], hosts: [host({ last_seen_at: "2026-10-29T12:05:00.000Z" })] },
    ]);
    expect(alerts.map((a) => a.kind)).toEqual(["host_disconnected", "host_reconnected"]);
  });

  it.each(["approval_required", "waiting_for_input", "failed", "completed"] as const)("alerts when a session becomes %s", (status) => {
    const alerts = run([
      { sessions: [session()], hosts: [host()] },
      { sessions: [session({ status, last_activity_at: "2026-10-29T12:01:00.000Z" })], hosts: [host()] },
    ]);
    expect(alerts).toEqual([
      { id: `s:s1:${status}:2026-10-29T12:01:00.000Z`, kind: status, sessionId: "s1", hostId: HOST, at: "2026-10-29T12:01:00.000Z", isDemo: false },
    ]);
  });

  it("does not alert on non-attention transitions or unchanged status", () => {
    const alerts = run([
      { sessions: [session({ status: "waiting_for_input" })], hosts: [host()] },
      { sessions: [session({ status: "running" })], hosts: [host()] },
      { sessions: [session({ status: "running" })], hosts: [host()] },
      { sessions: [session({ status: "ended" })], hosts: [host()] },
      { sessions: [session({ status: "unknown" })], hosts: [host()] },
    ]);
    expect(alerts).toEqual([]);
  });

  it("ignores a response older than one already seen (a slow refetch), so a dismissed alert isn't raised again", () => {
    const at = (m: number) => `2026-10-29T12:0${m}:00.000Z`;
    const alerts = run([
      { sessions: [session({ updated_at: at(0) })], hosts: [host()] },
      { sessions: [session({ status: "approval_required", last_activity_at: at(1), updated_at: at(1) })], hosts: [host()] },
      { sessions: [session({ status: "running", last_activity_at: at(2), updated_at: at(2) })], hosts: [host()] },
      // The approval response arrives late, after the newer "running" one.
      { sessions: [session({ status: "approval_required", last_activity_at: at(1), updated_at: at(1) })], hosts: [host()] },
      { sessions: [session({ status: "running", last_activity_at: at(2), updated_at: at(2) })], hosts: [host()] },
    ]);
    expect(alerts.map((a) => a.id)).toEqual([`s:s1:approval_required:${at(1)}`]);
  });

  it("alerts the same attention status again after unknown when activity moved on (a turn the source couldn't name)", () => {
    const at = (m: number) => `2026-10-29T12:0${m}:00.000Z`;
    const alerts = run([
      { sessions: [session({ updated_at: at(0) })], hosts: [host()] },
      { sessions: [session({ status: "approval_required", last_activity_at: at(1), updated_at: at(1) })], hosts: [host()] },
      { sessions: [session({ status: "unknown", last_activity_at: at(2), updated_at: at(2) })], hosts: [host()] },
      { sessions: [session({ status: "approval_required", last_activity_at: at(3), updated_at: at(3) })], hosts: [host()] },
      { sessions: [session({ status: "unknown", last_activity_at: at(4), updated_at: at(4) })], hosts: [host()] },
      { sessions: [session({ status: "failed", last_activity_at: at(5), updated_at: at(5) })], hosts: [host()] },
    ]);
    expect(alerts.map((a) => `${a.kind}:${a.at}`)).toEqual([`approval_required:${at(1)}`, `approval_required:${at(3)}`, `failed:${at(5)}`]);
  });

  it("raises nothing for the same status after unknown when activity didn't move, even once the first alert was dismissed", () => {
    const at = (m: number) => `2026-10-29T12:0${m}:00.000Z`;
    const alerts = run([
      { sessions: [session({ updated_at: at(0) })], hosts: [host()] },
      { sessions: [session({ status: "waiting_for_input", last_activity_at: at(1), updated_at: at(1) })], hosts: [host()] },
      // Only updated_at moves: the source re-read the same turn.
      { sessions: [session({ status: "unknown", last_activity_at: at(1), updated_at: at(2) })], hosts: [host()] },
      { sessions: [session({ status: "waiting_for_input", last_activity_at: at(1), updated_at: at(3) })], hosts: [host()] },
    ]);
    // One alert only: detection itself doesn't re-raise it, so dismissing it can't bring it back.
    expect(alerts.map((a) => a.id)).toEqual([`s:s1:waiting_for_input:${at(1)}`]);
  });

  it("stays silent after unknown when the session has no activity time to tell a new event by", () => {
    const at = (m: number) => `2026-10-29T12:0${m}:00.000Z`;
    const alerts = run([
      { sessions: [session({ last_activity_at: null, updated_at: at(0) })], hosts: [host()] },
      { sessions: [session({ status: "completed", last_activity_at: null, updated_at: at(1) })], hosts: [host()] },
      { sessions: [session({ status: "unknown", last_activity_at: null, updated_at: at(2) })], hosts: [host()] },
      { sessions: [session({ status: "completed", last_activity_at: null, updated_at: at(3) })], hosts: [host()] },
    ]);
    expect(alerts.map((a) => a.id)).toEqual([`s:s1:completed:${at(1)}`]);
  });

  it("does not alert a non-attention status regained after unknown", () => {
    const at = (m: number) => `2026-10-29T12:0${m}:00.000Z`;
    const alerts = run([
      { sessions: [session({ updated_at: at(0) })], hosts: [host()] },
      { sessions: [session({ status: "unknown", last_activity_at: at(1), updated_at: at(1) })], hosts: [host()] },
      { sessions: [session({ status: "running", last_activity_at: at(2), updated_at: at(2) })], hosts: [host()] },
    ]);
    expect(alerts).toEqual([]);
  });

  it("produces the same id for the same event, so repeated detection dedupes", () => {
    const steps = [
      { sessions: [session()], hosts: [host()] },
      { sessions: [session({ status: "failed" })], hosts: [host()] },
    ];
    expect(run(steps)[0]?.id).toBe(run(steps)[0]?.id);
  });

  it("only alerts new sessions that need approval or failed", () => {
    const alerts = run([
      { sessions: [], hosts: [host()] },
      {
        sessions: [
          session({ id: "a", status: "waiting_for_input" }),
          session({ id: "b", status: "approval_required" }),
          session({ id: "c", status: "completed" }),
          session({ id: "d", status: "failed" }),
        ],
        hosts: [host()],
      },
    ]);
    expect(alerts.map((a) => `${a.sessionId}:${a.kind}`)).toEqual(["b:approval_required", "d:failed"]);
  });

  it("never alerts on sessions behind an offline host", () => {
    const alerts = run([
      { sessions: [session()], hosts: [host({ connectivity: "never_connected" })] },
      { sessions: [session({ status: "approval_required" })], hosts: [host({ connectivity: "never_connected" })] },
    ]);
    expect(alerts).toEqual([]);
  });

  it("keeps the last trusted status through an outage: unchanged status → no alert on reconnect", () => {
    const alerts = run([
      { sessions: [session({ status: "waiting_for_input" })], hosts: [host()] },
      { sessions: [session({ status: "waiting_for_input" })], hosts: [host({ connectivity: "disconnected" })] },
      { sessions: [session({ status: "waiting_for_input" })], hosts: [host({ last_seen_at: "2026-10-29T12:05:00.000Z" })] },
    ]);
    expect(alerts.map((a) => a.kind)).toEqual(["host_disconnected", "host_reconnected"]);
  });

  it("alerts after reconnect when the status changed during the outage", () => {
    const alerts = run([
      { sessions: [session()], hosts: [host()] },
      { sessions: [session({ status: "failed" })], hosts: [host({ connectivity: "disconnected" })] },
      { sessions: [session({ status: "failed" })], hosts: [host({ last_seen_at: "2026-10-29T12:05:00.000Z" })] },
    ]);
    expect(alerts.map((a) => a.kind)).toEqual(["host_disconnected", "host_reconnected", "failed"]);
  });

  it("does not alert on first connection or revocation", () => {
    const alerts = run([
      { sessions: [], hosts: [host({ connectivity: "never_connected", last_seen_at: null })] },
      { sessions: [], hosts: [host()] },
      { sessions: [], hosts: [host({ connectivity: "revoked" })] },
    ]);
    expect(alerts).toEqual([]);
  });

  it("uses the host's last heartbeat for host alert identity", () => {
    const [a] = run([
      { sessions: [], hosts: [host()] },
      { sessions: [], hosts: [host({ connectivity: "disconnected" })] },
    ]);
    expect(a).toMatchObject({ id: "h:h1:disconnected:2026-10-29T12:00:00.000Z", kind: "host_disconnected", sessionId: null, at: "2026-10-29T12:00:00.000Z" });
  });

  describe("session source health", () => {
    const failing = (over: Partial<AlertHostInput> = {}) => host({ provider_error_since: "2026-10-29T12:01:00.000Z", last_seen_at: "2026-10-29T12:01:30.000Z", ...over });

    it("alerts once when the source stops and once when it recovers", () => {
      const alerts = run([
        { sessions: [], hosts: [host()] },
        { sessions: [], hosts: [failing()] },
        { sessions: [], hosts: [failing({ last_seen_at: "2026-10-29T12:02:00.000Z" })] },
        { sessions: [], hosts: [host({ last_seen_at: "2026-10-29T12:03:00.000Z" })] },
      ]);
      expect(alerts.map((a) => [a.kind, a.id, a.sessionId])).toEqual([
        ["source_unavailable", "src:h1:down:2026-10-29T12:01:00.000Z", null],
        ["source_recovered", "src:h1:ok:2026-10-29T12:03:00.000Z", null],
      ]);
    });

    it("never alerts on sessions while the source is failing, and does not mistake a stale status for news", () => {
      const alerts = run([
        { sessions: [session({ status: "running" })], hosts: [host()] },
        // The stored status changes while the source is down: untrusted, no alert.
        { sessions: [session({ status: "completed" })], hosts: [failing()] },
        // Recovery with a genuinely changed status: alert once, after the source alert.
        { sessions: [session({ status: "completed" })], hosts: [host({ last_seen_at: "2026-10-29T12:03:00.000Z" })] },
      ]);
      expect(alerts.map((a) => a.kind)).toEqual(["source_unavailable", "source_recovered", "completed"]);
    });

    it("does not judge source health while the host is offline, and remembers it", () => {
      const alerts = run([
        { sessions: [], hosts: [host()] },
        { sessions: [], hosts: [failing({ connectivity: "disconnected" })] },
        { sessions: [], hosts: [host({ last_seen_at: "2026-10-29T12:05:00.000Z" })] },
      ]);
      expect(alerts.map((a) => a.kind)).toEqual(["host_disconnected", "host_reconnected"]);
    });

    it("treats a source already failing at baseline as known", () => {
      expect(run([{ sessions: [], hosts: [failing()] }, { sessions: [], hosts: [failing()] }])).toEqual([]);
    });

    it("maps source alerts to the host connectivity preferences", () => {
      const prefs = { on_waiting_for_input: true, on_approval_required: true, on_completed: true, on_failed: true, on_host_disconnected: false, on_host_reconnected: true };
      expect(alertAllowed("source_unavailable", prefs)).toBe(false);
      expect(alertAllowed("source_recovered", prefs)).toBe(true);
    });

    it("keeps stored source alerts valid as host alerts", () => {
      const stored = { id: "src:h1:down:2026-10-29T12:01:00.000Z", kind: "source_unavailable", sessionId: null, hostId: "h1", at: "2026-10-29T12:01:00.000Z", isDemo: false, read: false };
      expect(parseStoredAlerts([stored, { ...stored, id: "x", sessionId: "s1" }]).map((a) => a.id)).toEqual([stored.id]);
    });
  });

  it("forgets sessions that disappear", () => {
    const r1 = detectAlerts(null, [session()], [host()]);
    const r2 = detectAlerts(r1.snapshot, [], [host()]);
    expect(r2.snapshot.sessions.size).toBe(0);
  });

  it("carries the demo flag", () => {
    const alerts = run([
      { sessions: [session({ is_demo: true })], hosts: [host()] },
      { sessions: [session({ is_demo: true, status: "failed" })], hosts: [host()] },
    ]);
    expect(alerts[0]?.isDemo).toBe(true);
  });
});

describe("alertAllowed", () => {
  const prefs: NotificationPrefs = {
    on_waiting_for_input: false,
    on_approval_required: true,
    on_completed: false,
    on_failed: true,
    on_host_disconnected: true,
    on_host_reconnected: false,
  };
  it("follows the matching preference", () => {
    expect(alertAllowed("approval_required", prefs)).toBe(true);
    expect(alertAllowed("waiting_for_input", prefs)).toBe(false);
    expect(alertAllowed("completed", prefs)).toBe(false);
    expect(alertAllowed("failed", prefs)).toBe(true);
    expect(alertAllowed("host_disconnected", prefs)).toBe(true);
    expect(alertAllowed("host_reconnected", prefs)).toBe(false);
  });
});

const alert = (id: string, at: string): TavroAlert => ({ id, kind: "failed", sessionId: "s1", hostId: HOST, at, isDemo: false });

describe("mergeAlerts", () => {
  it("adds new alerts unread, newest first", () => {
    const merged = mergeAlerts([], [alert("a", "2026-10-29T12:00:00Z"), alert("b", "2026-10-29T12:01:00Z")]);
    expect(merged.map((a) => a.id)).toEqual(["b", "a"]);
    expect(unreadCount(merged)).toBe(2);
  });

  it("ignores duplicates, including within one batch, and keeps read state", () => {
    const existing: StoredAlert[] = [{ ...alert("a", "2026-10-29T12:00:00Z"), read: true }];
    const merged = mergeAlerts(existing, [alert("a", "2026-10-29T12:00:00Z"), alert("b", "2026-10-29T12:01:00Z"), alert("b", "2026-10-29T12:01:00Z")]);
    expect(merged.map((a) => [a.id, a.read])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("returns the same array when nothing is new", () => {
    const existing: StoredAlert[] = [{ ...alert("a", "2026-10-29T12:00:00Z"), read: false }];
    expect(mergeAlerts(existing, [alert("a", "2026-10-29T12:00:00Z")])).toBe(existing);
  });

  it("keeps a newly detected alert about an older event when the list is full", () => {
    const full: StoredAlert[] = Array.from({ length: MAX_STORED_ALERTS }, (_, i) => ({ ...alert(`old${i}`, new Date(Date.UTC(2026, 9, 29, 12, i)).toISOString()), read: true }));
    const merged = mergeAlerts(full, [alert("late", "2026-10-29T09:00:00Z")]);
    expect(merged[0]?.id).toBe("late");
    expect(merged).toHaveLength(MAX_STORED_ALERTS);
  });

  it("caps the list, dropping the oldest", () => {
    const incoming = Array.from({ length: MAX_STORED_ALERTS + 5 }, (_, i) => alert(`x${i}`, new Date(Date.UTC(2026, 9, 29, 0, i)).toISOString()));
    const merged = mergeAlerts([], incoming);
    expect(merged).toHaveLength(MAX_STORED_ALERTS);
    expect(merged[0]?.id).toBe(`x${MAX_STORED_ALERTS + 4}`);
    expect(merged.some((a) => a.id === "x0")).toBe(false);
  });
});

describe("parseStoredAlerts", () => {
  it("keeps valid entries and drops malformed ones", () => {
    const valid = { ...alert("a", "2026-10-29T12:00:00Z"), read: false };
    const parsed = parseStoredAlerts([
      valid,
      { ...valid, id: "b", kind: "exploded" },
      { ...valid, id: "c", at: "not a date" },
      { ...valid, id: "d", read: "yes" },
      { ...valid, id: "e", title: "extra fields are stripped" },
      null,
      "junk",
    ]);
    expect(parsed.map((a) => a.id)).toEqual(["a", "e"]);
    expect(parsed[1]).not.toHaveProperty("title");
  });

  it("rejects malformed or inconsistent ids", () => {
    const valid = { ...alert("a", "2026-10-29T12:00:00Z"), read: false };
    const hostAlert = { ...valid, id: "h", kind: "host_disconnected", sessionId: null };
    const parsed = parseStoredAlerts([
      { ...valid, id: "path", sessionId: "../settings?x=1" },
      { ...valid, id: "long", hostId: "x".repeat(65) },
      { ...valid, id: "nosession", sessionId: null },
      { ...hostAlert, id: "hostwithsession", sessionId: "s1" },
      hostAlert,
    ]);
    expect(parsed.map((a) => a.id)).toEqual(["h"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(parseStoredAlerts(null)).toEqual([]);
    expect(parseStoredAlerts({ id: "a" })).toEqual([]);
  });
});

describe("alertNotificationText", () => {
  it("is generic and marks demo alerts", () => {
    expect(alertNotificationText({ kind: "approval_required", isDemo: false })).toEqual({
      title: "Tavro · Needs approval",
      body: "A session is waiting for your approval.",
    });
    expect(alertNotificationText({ kind: "failed", isDemo: true }).title).toBe("Tavro demo · Failed");
  });

  it("adds names only when given, normalising whitespace and capping length", () => {
    expect(alertNotificationText({ kind: "failed", isDemo: false }, { session: "  Fix\n auth   tests ", host: "Work laptop" }).body).toBe(
      "Fix auth tests · Work laptop\nA session reported a failure.",
    );
    expect(alertNotificationText({ kind: "host_disconnected", isDemo: false }, { session: null, host: "Desk" }).body).toBe(
      "Desk\nA host stopped reporting. Its sessions may be out of date.",
    );
    expect(alertNotificationText({ kind: "failed", isDemo: false }, { session: "  ", host: "" }).body).toBe("A session reported a failure.");
    const long = alertNotificationText({ kind: "failed", isDemo: false }, { session: "x".repeat(200) }).body.split("\n")[0] ?? "";
    expect(long).toHaveLength(MAX_NOTIFICATION_NAME_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("strips control and bidi characters and never splits an emoji", () => {
    expect(notificationName("evil‮close\u0007name")).toBe("evil close name");
    const emoji = notificationName("😀".repeat(100)) ?? "";
    expect(Array.from(emoji)).toHaveLength(MAX_NOTIFICATION_NAME_LENGTH);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false);
  });
});
