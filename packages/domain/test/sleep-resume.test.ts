// Alert detection across sleep and resume (spec 4.2 "avoid false transitions
// after sleep", 5.7 "no false disconnection alerts during sleep", Part 16).
// Each step is one client fetch: connectivity is judged at that fetch's time,
// exactly as the web watcher does, and the fetch time is passed to detection.
import type { SessionStatus } from "@mc/contracts";
import { describe, expect, it } from "vitest";
import {
  DISCONNECT_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  detectAlerts,
  hostConnectivity,
  type AlertSessionInput,
  type AlertSnapshot,
  type TavroAlert,
} from "../src/index.js";

const HOST = "h1";
const T0 = Date.parse("2026-10-29T12:00:00.000Z");
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Fetch {
  /** Client clock when the host list was fetched. */
  at: number;
  /** The host's last heartbeat as stored. */
  lastSeen: number;
  sessions: Record<string, SessionStatus>;
}

function sessions(f: Fetch): AlertSessionInput[] {
  return Object.entries(f.sessions).map(([id, status]) => ({ id, host_id: HOST, status, last_activity_at: iso(f.lastSeen), updated_at: iso(f.lastSeen), is_demo: false }));
}

/** Runs detection over successive fetches; returns every alert and the final snapshot. */
function watch(fetches: Fetch[], snap: AlertSnapshot | null = null): { alerts: TavroAlert[]; snap: AlertSnapshot | null } {
  const alerts: TavroAlert[] = [];
  for (const f of fetches) {
    const observedAt = new Date(f.at);
    const host = { id: HOST, connectivity: hostConnectivity({ last_seen_at: iso(f.lastSeen), revoked_at: null }, observedAt), last_seen_at: iso(f.lastSeen), provider_error_since: null, is_demo: false };
    const r = detectAlerts(snap, sessions(f), [host], observedAt);
    alerts.push(...r.alerts);
    snap = r.snapshot;
  }
  return { alerts, snap };
}

const kinds = (alerts: TavroAlert[]) => alerts.map((a) => `${a.kind}${a.sessionId ? `:${a.sessionId}` : ""}`);

/** A client polling every heartbeat from `from` to `to`, while the host is last seen at `lastSeen(t)`. */
function polls(from: number, to: number, lastSeen: (t: number) => number, status: (t: number) => Record<string, SessionStatus>): Fetch[] {
  const out: Fetch[] = [];
  for (let t = from; t <= to; t += HEARTBEAT_INTERVAL_MS) out.push({ at: t, lastSeen: lastSeen(t), sessions: status(t) });
  return out;
}

const BEFORE = { same: "running", changed: "running", gone: "running" } as const;

describe("laptop sleeps while the phone keeps watching", () => {
  const sleepAt = T0 + MINUTE;
  const wakeAt = sleepAt + 20 * MINUTE;

  it("alerts one disconnection, one reconnection, and only sessions that really changed", () => {
    const { alerts } = watch([
      // Awake: heartbeats keep last_seen current.
      ...polls(T0, sleepAt, (t) => t, () => BEFORE),
      // Asleep: last_seen frozen. The stored statuses are those from before the sleep.
      ...polls(sleepAt + HEARTBEAT_INTERVAL_MS, wakeAt, () => sleepAt, () => BEFORE),
      // Resumed: the heartbeat lands before the session writes, so one fetch sees the old statuses.
      { at: wakeAt + 5000, lastSeen: wakeAt + 2000, sessions: BEFORE },
      { at: wakeAt + 35_000, lastSeen: wakeAt + 32_000, sessions: { same: "running", changed: "approval_required", gone: "ended" } },
      { at: wakeAt + 65_000, lastSeen: wakeAt + 62_000, sessions: { same: "running", changed: "approval_required", gone: "ended" } },
    ]);
    // An ended session is never reported as completed or failed.
    expect(kinds(alerts)).toEqual(["host_disconnected", "host_reconnected", "approval_required:changed"]);
    // The disconnection is dated by the last heartbeat, not by when it was noticed.
    expect(alerts[0]?.at).toBe(iso(sleepAt));
  });

  it("notices the disconnection as soon as the threshold passes", () => {
    const { alerts } = watch(polls(T0, T0 + 3 * MINUTE, (t) => Math.min(t, T0), () => BEFORE));
    expect(kinds(alerts)).toEqual(["host_disconnected"]);
  });

  it("tolerates background-tab throttling (one poll a minute) without delaying the alert", () => {
    const fetches: Fetch[] = [];
    for (let t = T0; t <= T0 + 3 * MINUTE; t += MINUTE) fetches.push({ at: t, lastSeen: T0, sessions: BEFORE });
    const { alerts } = watch(fetches);
    expect(kinds(alerts)).toEqual(["host_disconnected"]);
  });
});

describe("phone locked while the laptop keeps working", () => {
  it("judges the host at fetch time and alerts each real change once", () => {
    const resumeAt = T0 + 30 * MINUTE;
    const { alerts } = watch([
      { at: T0, lastSeen: T0, sessions: { a: "running", b: "running", c: "waiting_for_input" } },
      // 30 minutes without a fetch; the laptop heartbeated all along.
      { at: resumeAt, lastSeen: resumeAt - 10_000, sessions: { a: "completed", b: "running", c: "waiting_for_input" } },
      { at: resumeAt + 30_000, lastSeen: resumeAt + 20_000, sessions: { a: "completed", b: "running", c: "waiting_for_input" } },
    ]);
    expect(kinds(alerts)).toEqual(["completed:a"]);
  });

  it("still reports a host that really went down while the phone was locked, after a grace", () => {
    const resumeAt = T0 + 30 * MINUTE;
    const downAt = T0 + 10 * MINUTE;
    const { alerts } = watch([
      ...polls(T0, T0, (t) => t, () => BEFORE),
      ...polls(resumeAt, resumeAt + 2 * MINUTE, () => downAt, () => BEFORE),
    ]);
    expect(alerts).toEqual([{ id: `h:${HOST}:disconnected:${iso(downAt)}`, kind: "host_disconnected", sessionId: null, hostId: HOST, at: iso(downAt), isDemo: false }]);
  });
});

describe("laptop and browser asleep together (lid closed)", () => {
  const sleepAt = T0 + MINUTE;
  const wakeAt = sleepAt + 45 * MINUTE;
  const awake = polls(T0, sleepAt, (t) => t, () => BEFORE);

  it("raises no disconnection when the browser's first fetch beats the connector's first heartbeat", () => {
    const { alerts } = watch([
      ...awake,
      // Both wake; the browser fetches before the connector has reported.
      { at: wakeAt + 1000, lastSeen: sleepAt, sessions: BEFORE },
      { at: wakeAt + 31_000, lastSeen: sleepAt, sessions: BEFORE }, // connector still waiting for the network
      { at: wakeAt + 61_000, lastSeen: wakeAt + 50_000, sessions: { same: "running", changed: "failed", gone: "ended" } },
      { at: wakeAt + 91_000, lastSeen: wakeAt + 80_000, sessions: { same: "running", changed: "failed", gone: "ended" } },
    ]);
    expect(kinds(alerts)).toEqual(["failed:changed"]);
  });

  it("reports the disconnection once the host stays silent through the grace after resume", () => {
    const { alerts } = watch([...awake, ...polls(wakeAt, wakeAt + 3 * MINUTE, () => sleepAt, () => BEFORE)]);
    expect(kinds(alerts)).toEqual(["host_disconnected"]);
    expect(alerts[0]?.at).toBe(iso(sleepAt));
  });

  it("keeps sessions untrusted during the grace, so nothing behind the silent host alerts", () => {
    const { alerts } = watch([
      ...awake,
      { at: wakeAt, lastSeen: sleepAt, sessions: { same: "failed", changed: "completed", gone: "approval_required" } },
    ]);
    expect(alerts).toEqual([]);
  });
});

describe("phone opened briefly every few minutes while the laptop is dead", () => {
  const deadAt = T0 + MINUTE;
  const awake = polls(T0, deadAt, (t) => t, () => BEFORE);
  /** A 30 s look at the app (two fetches) starting at `at`; the host's last heartbeat stays at `deadAt`. */
  const glance = (at: number) => polls(at, at + HEARTBEAT_INTERVAL_MS, () => deadAt, () => BEFORE);

  it("grants the sleep grace once per heartbeat, then alerts exactly once with a stable id", () => {
    const first = watch([...awake, ...glance(deadAt + 5 * MINUTE)]);
    // The first short look may have slept along with the laptop: held back.
    expect(first.alerts).toEqual([]);
    const rest = watch([...glance(deadAt + 10 * MINUTE), ...glance(deadAt + 15 * MINUTE)], first.snap);
    expect(rest.alerts).toEqual([{ id: `h:${HOST}:disconnected:${iso(deadAt)}`, kind: "host_disconnected", sessionId: null, hostId: HOST, at: iso(deadAt), isDemo: false }]);
  });

  it("grants a fresh grace once the host has reported again", () => {
    const { alerts } = watch([
      ...awake,
      ...glance(deadAt + 5 * MINUTE),
      // The laptop came back between the looks, then slept again just before the next one.
      { at: deadAt + 8 * MINUTE, lastSeen: deadAt + 8 * MINUTE - 5000, sessions: BEFORE },
      ...polls(deadAt + 12 * MINUTE, deadAt + 12 * MINUTE + HEARTBEAT_INTERVAL_MS, () => deadAt + 8 * MINUTE - 5000, () => BEFORE),
    ]);
    expect(alerts).toEqual([]);
  });
});

describe("clock jumps on the client", () => {
  it("treats a backwards jump like a gap: no false disconnection", () => {
    const { alerts } = watch([
      { at: T0, lastSeen: T0, sessions: BEFORE },
      // The client clock ran 10 minutes fast, then was corrected; the host was seen 2 min before the fetch.
      { at: T0 + 10 * MINUTE, lastSeen: T0, sessions: BEFORE },
      { at: T0 + 2 * MINUTE, lastSeen: T0 + 2 * MINUTE - 5000, sessions: BEFORE },
    ]);
    expect(alerts).toEqual([]);
  });

  it("a host whose last heartbeat is ahead of the client clock counts as online", () => {
    expect(hostConnectivity({ last_seen_at: iso(T0 + 5 * MINUTE), revoked_at: null }, new Date(T0))).toBe("online");
    expect(hostConnectivity({ last_seen_at: iso(T0), revoked_at: null }, new Date(T0 + DISCONNECT_AFTER_MS))).toBe("online");
    expect(hostConnectivity({ last_seen_at: iso(T0), revoked_at: null }, new Date(T0 + DISCONNECT_AFTER_MS + 1))).toBe("disconnected");
  });
});

describe("without a fetch time", () => {
  it("keeps the previous behaviour: no grace", () => {
    const host = (connectivity: "online" | "disconnected") => ({ id: HOST, connectivity, last_seen_at: iso(T0), provider_error_since: null, is_demo: false });
    const r1 = detectAlerts(null, [], [host("online")]);
    expect(detectAlerts(r1.snapshot, [], [host("disconnected")]).alerts.map((a) => a.kind)).toEqual(["host_disconnected"]);
  });
});
