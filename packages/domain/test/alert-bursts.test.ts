import { describe, expect, it } from "vitest";
import {
  ALERT_GROUP_WINDOW_MS,
  NOTIFICATION_BURST_MAX_AGE_MS,
  NOTIFICATION_BURST_MAX_COUNT,
  NOTIFICATION_BURST_WINDOW_MS,
  NOTIFICATION_MAX_SILENT_MS,
  alertSummaryText,
  groupAlerts,
  mergeAlerts,
  parseNotificationBurst,
  planNotifications,
  summarizeAlerts,
  unreadCount,
  type AlertKind,
  type StoredAlert,
  type TavroAlert,
} from "../src/index.js";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let seq = 0;
function alert(kind: AlertKind, minutes: number, over: Partial<StoredAlert> = {}): StoredAlert {
  const sessionId = kind.startsWith("host_") || kind.startsWith("source_") ? null : `s${++seq}`;
  return { id: `${kind}:${minutes}:${++seq}`, kind, sessionId, hostId: "h1", at: at(minutes), isDemo: false, read: false, ...over };
}
const ids = (groups: ReturnType<typeof groupAlerts>) => groups.map((g) => g.alerts.map((a) => a.id));

describe("groupAlerts", () => {
  it("folds simultaneous completions on one host into one group, keeping every alert", () => {
    const list = [alert("completed", 0), alert("completed", 0), alert("completed", 0)];
    const groups = groupAlerts(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.alerts).toEqual(list);
    expect(groups[0]?.unread).toBe(3);
  });

  it("never folds approvals or failures, each is its own action item", () => {
    const list = [alert("approval_required", 0), alert("approval_required", 0), alert("failed", 0), alert("failed", 0)];
    expect(groupAlerts(list)).toHaveLength(4);
  });

  it("folds a flapping host (disconnect and reconnect) into one group", () => {
    const list = [alert("host_reconnected", 3), alert("host_disconnected", 2), alert("host_reconnected", 1), alert("host_disconnected", 0)];
    expect(ids(groupAlerts(list))).toEqual([list.map((a) => a.id)]);
  });

  it("keeps different hosts, different families and non-consecutive runs apart", () => {
    const a = alert("completed", 0);
    const b = alert("completed", 0, { hostId: "h2" });
    const c = alert("waiting_for_input", 0);
    const d = alert("completed", 0);
    expect(groupAlerts([a, b, c, d])).toHaveLength(4);
  });

  it("splits at the window boundary: exactly the window folds, one ms more does not", () => {
    const inside = [alert("completed", ALERT_GROUP_WINDOW_MS / 60_000), alert("completed", 0)];
    expect(groupAlerts(inside)).toHaveLength(1);
    const late = { ...alert("completed", 0), at: new Date(T0 + ALERT_GROUP_WINDOW_MS + 1).toISOString() };
    expect(groupAlerts([late, alert("completed", 0)])).toHaveLength(2);
  });

  it("measures the window across the whole group, not just neighbours", () => {
    // Each step is 6 minutes apart; three of them span 12 minutes.
    const list = [alert("completed", 12), alert("completed", 6), alert("completed", 0)];
    expect(groupAlerts(list).map((g) => g.alerts.length)).toEqual([1, 2]);
  });

  it("keeps existing groups and their ids stable when new alerts arrive at the front", () => {
    const old = [alert("completed", 6), alert("completed", 0)];
    const before = groupAlerts(old);
    const after = groupAlerts([alert("completed", 12), ...old]);
    expect(after.at(-1)?.id).toBe(before[0]?.id);
    expect(after.at(-1)?.alerts).toEqual(before[0]?.alerts);
  });

  it("keeps the unread total equal to the stored unread count", () => {
    const list = [alert("completed", 0), alert("completed", 0, { read: true }), alert("failed", 0), alert("host_disconnected", 0, { read: true })];
    const groups = groupAlerts(list);
    expect(groups.reduce((n, g) => n + g.unread, 0)).toBe(unreadCount(list));
  });

  it("returns no groups for no alerts", () => {
    expect(groupAlerts([])).toEqual([]);
  });

  it("does not drop repeated events: a duplicate id is already rejected by mergeAlerts", () => {
    const a = alert("completed", 0);
    const stored = mergeAlerts(mergeAlerts([], [a]), [a]);
    expect(groupAlerts(stored).flatMap((g) => g.alerts)).toHaveLength(1);
  });
});

describe("planNotifications", () => {
  const t = (kind: AlertKind, n = 0): TavroAlert => {
    const { id, kind: k, sessionId, hostId, at: when, isDemo } = alert(kind, n);
    return { id, kind: k, sessionId, hostId, at: when, isDemo };
  };
  type Burst = ReturnType<typeof planNotifications>["burst"];
  /** Runs one detection pass after another, collecting the plans. */
  function runs(steps: { at: number; added: TavroAlert[] }[]) {
    let burst: Burst = null;
    return steps.map((s) => {
      const r = planNotifications(burst, s.added, s.at);
      burst = r.burst;
      return { plan: r.plan, burst };
    });
  }

  it("shows the first alert since the user last looked as an ordinary notification", () => {
    const a = t("approval_required");
    const { plan, burst } = planNotifications(null, [a], T0);
    expect(plan).toEqual({ kind: "single", alert: a });
    expect(burst).toEqual({ summary: { counts: { approval_required: 1 }, total: 1, allDemo: false }, lastShownAt: T0, lastAudibleAt: T0 });
  });

  it("collapses simultaneous alerts into one audible summary", () => {
    const { plan } = planNotifications(null, [t("approval_required"), t("completed"), t("completed")], T0);
    expect(plan).toEqual({ kind: "summary", summary: { counts: { approval_required: 1, completed: 2 }, total: 3, allDemo: false }, silent: false });
  });

  it("stays silent only for more of a kind the user was just alerted about", () => {
    const [, second] = runs([
      { at: T0, added: [t("completed")] },
      { at: T0 + NOTIFICATION_BURST_WINDOW_MS, added: [t("completed")] },
    ]);
    expect(second?.plan).toMatchObject({ kind: "summary", silent: true, summary: { total: 2 } });
  });

  it("is always audible for an approval or a failure, even mid-burst and of a kind already notified", () => {
    const [, approval, failure, again] = runs([
      { at: T0, added: [t("completed"), t("approval_required")] },
      { at: T0 + 30_000, added: [t("approval_required")] },
      { at: T0 + 60_000, added: [t("failed")] },
      { at: T0 + 90_000, added: [t("failed")] },
    ]);
    for (const r of [approval, failure, again]) expect(r?.plan).toMatchObject({ kind: "summary", silent: false });
  });

  it("is audible for a new kind of event in a burst", () => {
    const [, second] = runs([
      { at: T0, added: [t("completed")] },
      { at: T0 + 30_000, added: [t("host_disconnected")] },
    ]);
    expect(second?.plan).toMatchObject({ kind: "summary", silent: false });
  });

  it("counts everything since the user last looked, so a summary never hides an earlier unseen notification", () => {
    // The approval is notified on its own; much later, two completions arrive.
    const [, later] = runs([
      { at: T0, added: [t("approval_required")] },
      { at: T0 + 5 * 60_000, added: [t("completed"), t("completed")] },
    ]);
    expect(later?.plan).toMatchObject({ kind: "summary", silent: false, summary: { counts: { approval_required: 1, completed: 2 }, total: 3 } });
    expect(later?.plan && alertSummaryText(later.plan.kind === "summary" ? later.plan.summary : summarizeAlerts([])).body).toBe("1 needs approval, 2 completed.");
  });

  it("makes a sound after a pause in notifications longer than the window", () => {
    const [, later] = runs([
      { at: T0, added: [t("completed")] },
      { at: T0 + NOTIFICATION_BURST_WINDOW_MS + 1, added: [t("completed")] },
    ]);
    expect(later?.plan).toMatchObject({ kind: "summary", silent: false });
  });

  it("keeps a flapping host to one notification per run, audible at most every 10 minutes, with bounded state", () => {
    const steps = Array.from({ length: 60 }, (_, i) => ({ at: T0 + i * 30_000, added: [t("host_disconnected"), t("host_reconnected")] }));
    const results = runs(steps);
    const audibleAt = results.flatMap((r, i) => (r.plan?.kind === "summary" && !r.plan.silent ? [i * 30_000] : []));
    // 30 minutes of flapping: a sound at the start and then once per 10 minutes, no more.
    expect(audibleAt.length).toBeGreaterThanOrEqual(3);
    expect(audibleAt.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < audibleAt.length; i++) expect((audibleAt[i] ?? 0) - (audibleAt[i - 1] ?? 0)).toBeGreaterThan(NOTIFICATION_MAX_SILENT_MS);
    const last = results.at(-1)?.burst;
    expect(last?.summary.total).toBe(120);
    expect(Object.keys(last?.summary.counts ?? {})).toHaveLength(2);
  });

  it("does nothing when nothing was added", () => {
    const prev = { summary: summarizeAlerts([t("completed")]), lastShownAt: T0, lastAudibleAt: T0 };
    expect(planNotifications(prev, [], T0 + 1)).toEqual({ plan: null, burst: prev });
  });
});

describe("alertSummaryText", () => {
  it("counts per kind, most urgent first, without names", () => {
    const { title, body } = alertSummaryText(
      summarizeAlerts([
        { kind: "completed", isDemo: false },
        { kind: "approval_required", isDemo: false },
        { kind: "completed", isDemo: false },
        { kind: "host_disconnected", isDemo: false },
      ]),
    );
    expect(title).toBe("Tavro · 4 new alerts");
    expect(body).toBe("1 needs approval, 2 completed, 1 host disconnection.");
  });

  it("pluralises and marks bursts that are entirely demo", () => {
    const demo = summarizeAlerts([
      { kind: "approval_required", isDemo: true },
      { kind: "approval_required", isDemo: true },
    ]);
    expect(alertSummaryText(demo)).toEqual({ title: "Tavro demo · 2 new alerts", body: "2 need approval." });
    expect(alertSummaryText(summarizeAlerts([{ kind: "failed", isDemo: false }], demo)).title).toBe("Tavro · 3 new alerts");
  });
});

// G32 / QA LOW-3: the user's tabs share one burst through storage. Each tab
// reads the stored copy before planning and writes its result back.
describe("a burst shared between tabs", () => {
  const t = (kind: AlertKind): TavroAlert => {
    const { id, kind: k, sessionId, hostId, at: when, isDemo } = alert(kind, 0);
    return { id, kind: k, sessionId, hostId, at: when, isDemo };
  };
  /** One tab's detection pass against the stored copy, as the watcher does it. */
  function tabPass(stored: { value: string | null }, added: TavroAlert[], now: number) {
    const previous = stored.value === null ? null : parseNotificationBurst(JSON.parse(stored.value), now);
    const r = planNotifications(previous, added, now);
    stored.value = r.burst ? JSON.stringify(r.burst) : null;
    return r.plan;
  }

  it("makes one sound for a storm split across two tabs' polls, but still sounds for an approval", () => {
    const stored = { value: null as string | null };
    // Tab A's poll finds one completion, tab B's poll (seconds later) two more.
    const a = tabPass(stored, [t("completed")], T0);
    const b = tabPass(stored, [t("completed"), t("completed")], T0 + 10_000);
    const a2 = tabPass(stored, [t("completed")], T0 + 40_000);
    expect(a).toMatchObject({ kind: "single" });
    expect(b).toMatchObject({ kind: "summary", silent: true, summary: { total: 3 } });
    expect(a2).toMatchObject({ kind: "summary", silent: true, summary: { total: 4 } });
    // D-018: anything the user must act on is always audible, whichever tab sees it.
    expect(tabPass(stored, [t("approval_required")], T0 + 50_000)).toMatchObject({ kind: "summary", silent: false });
  });

  it("documents the old per-tab behaviour it replaces: two tabs each sounded", () => {
    const [a, b] = [planNotifications(null, [t("completed")], T0), planNotifications(null, [t("completed"), t("completed")], T0 + 10_000)];
    expect(a.plan).toMatchObject({ kind: "single" });
    expect(b.plan).toMatchObject({ kind: "summary", silent: false });
  });

  it("round-trips a burst with counts, kinds and times only", () => {
    const { burst } = planNotifications(null, [t("completed"), t("host_disconnected")], T0);
    const json = JSON.stringify(burst);
    expect(parseNotificationBurst(JSON.parse(json), T0 + 1)).toEqual(burst);
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual(["lastAudibleAt", "lastShownAt", "summary"]);
    expect(json).not.toContain("h1");
  });

  it("forgets a burst that is too old or from the future", () => {
    const { burst } = planNotifications(null, [t("completed")], T0);
    expect(parseNotificationBurst(burst, T0 + NOTIFICATION_BURST_MAX_AGE_MS)).toEqual(burst);
    expect(parseNotificationBurst(burst, T0 + NOTIFICATION_BURST_MAX_AGE_MS + 1)).toBeNull();
    expect(parseNotificationBurst(burst, T0 - 1)).toBeNull();
  });

  it("rejects tampered or malformed values", () => {
    const ok = { summary: { counts: { completed: 2 }, total: 2, allDemo: false }, lastShownAt: T0, lastAudibleAt: T0 };
    const bad: unknown[] = [
      null,
      "x",
      [],
      { ...ok, lastShownAt: "soon" },
      { ...ok, lastAudibleAt: T0 + 1 },
      { ...ok, summary: { ...ok.summary, total: 3 } },
      { ...ok, summary: { ...ok.summary, total: 0, counts: {} } },
      { ...ok, summary: { ...ok.summary, counts: { completed: -1, failed: 3 } } },
      { ...ok, summary: { ...ok.summary, counts: { "Fix login": 2 } } },
      { ...ok, summary: { ...ok.summary, counts: { toString: 2 } } },
      { ...ok, summary: { ...ok.summary, counts: { completed: 1.5, failed: 0.5 } } },
      { ...ok, summary: { ...ok.summary, allDemo: "no" } },
      // Counts are safe integers under a sane cap: no precision loss, no absurd totals.
      { ...ok, summary: { ...ok.summary, counts: { completed: 2 ** 53, failed: 1 }, total: 2 ** 53 + 1 } },
      { ...ok, summary: { ...ok.summary, counts: { completed: Number.MAX_SAFE_INTEGER }, total: Number.MAX_SAFE_INTEGER } },
      { ...ok, summary: { ...ok.summary, counts: { completed: NOTIFICATION_BURST_MAX_COUNT + 1 }, total: NOTIFICATION_BURST_MAX_COUNT + 1 } },
    ];
    for (const v of bad) expect(parseNotificationBurst(v, T0 + 1)).toBeNull();
    expect(parseNotificationBurst(ok, T0 + 1)).toEqual(ok);
    const atCap = { ...ok, summary: { ...ok.summary, counts: { completed: NOTIFICATION_BURST_MAX_COUNT }, total: NOTIFICATION_BURST_MAX_COUNT } };
    expect(parseNotificationBurst(atCap, T0 + 1)).toEqual(atCap);
  });
});
