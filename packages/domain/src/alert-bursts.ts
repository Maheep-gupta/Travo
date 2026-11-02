import { ALERT_LABEL, type AlertKind, type StoredAlert, type TavroAlert } from "./alerts.js";

/**
 * Burst handling (spec 5.7, 16: "no notification storms"). A host outage that
 * ends, or a host that keeps dropping off, produces many alerts at once.
 * Stored alerts stay individual — ids, unread counts and read/dismiss state
 * are unchanged — and only their presentation is collapsed:
 *
 * - the notification centre folds runs of related alerts into one group;
 * - system notifications show one summary instead of one per alert.
 */

/**
 * Kinds that fold together. Approvals and failures are never folded: each is a
 * distinct thing the user has to act on. Connection and source changes fold
 * across both directions, so a flapping host reads as one group.
 */
const FAMILY: Record<AlertKind, string | null> = {
  approval_required: null,
  failed: null,
  waiting_for_input: "waiting",
  completed: "completed",
  host_disconnected: "host",
  host_reconnected: "host",
  source_unavailable: "source",
  source_recovered: "source",
};

/** Events further apart than this are separate occurrences, not a burst. */
export const ALERT_GROUP_WINDOW_MS = 10 * 60_000;

export interface AlertGroup {
  /** Stable while alerts are added: derived from the group's oldest member. */
  id: string;
  /** The newest member, which the group's heading describes. */
  latest: StoredAlert;
  /** Newest first, in stored order. A group of one is an ordinary alert. */
  alerts: StoredAlert[];
  unread: number;
}

/**
 * Folds consecutive alerts (in stored order, newest first) that share a host
 * and a family, and whose events all lie within `windowMs` of each other.
 * Groups are built from the oldest end, so alerts added at the front only ever
 * join the newest group: existing groups don't reshuffle when a new alert
 * arrives.
 */
export function groupAlerts(alerts: readonly StoredAlert[], windowMs = ALERT_GROUP_WINDOW_MS): AlertGroup[] {
  const groups: { family: string | null; hostId: string; min: number; max: number; alerts: StoredAlert[]; oldest: StoredAlert }[] = [];
  for (const a of [...alerts].reverse()) {
    const family = FAMILY[a.kind];
    const t = Date.parse(a.at) || 0;
    const last = groups[groups.length - 1];
    if (last && family !== null && last.family === family && last.hostId === a.hostId && Math.max(last.max, t) - Math.min(last.min, t) <= windowMs) {
      last.alerts.unshift(a);
      last.min = Math.min(last.min, t);
      last.max = Math.max(last.max, t);
    } else {
      groups.push({ family, hostId: a.hostId, min: t, max: t, alerts: [a], oldest: a });
    }
  }
  return groups.reverse().map((g) => ({
    id: `g:${g.oldest.id}`,
    latest: g.alerts[0] ?? g.oldest,
    alerts: g.alerts,
    unread: g.alerts.reduce((n, a) => n + (a.read ? 0 : 1), 0),
  }));
}

/** A notification within this long of the previous one may stay silent. */
export const NOTIFICATION_BURST_WINDOW_MS = 2 * 60_000;
/** A storm still makes a sound at least this often. */
export const NOTIFICATION_MAX_SILENT_MS = 10 * 60_000;

/** Always audible: each is something the user has to act on. */
const URGENT: ReadonlySet<AlertKind> = new Set(["approval_required", "failed"]);

/** Counts per kind: what a summary notification says. */
export interface AlertSummary {
  counts: Partial<Record<AlertKind, number>>;
  total: number;
  allDemo: boolean;
}

export function summarizeAlerts(alerts: readonly Pick<TavroAlert, "kind" | "isDemo">[], base?: AlertSummary): AlertSummary {
  const counts = { ...base?.counts };
  for (const a of alerts) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return { counts, total: (base?.total ?? 0) + alerts.length, allDemo: (base?.allDemo ?? true) && alerts.every((a) => a.isDemo) };
}

/**
 * Everything notified since the user last looked at Tavro (the watcher resets
 * it when the tab becomes visible). Counts only, so a long hidden storm can't
 * make it grow.
 */
export interface NotificationBurst {
  summary: AlertSummary;
  lastShownAt: number;
  lastAudibleAt: number;
}

export type NotificationPlan =
  /** The first alert since the user last looked: an ordinary per-alert notification. */
  | { kind: "single"; alert: TavroAlert }
  /**
   * One notification for everything since the user last looked. It replaces
   * the earlier ones, which it counts. `silent` when it only adds more of
   * what the user was just alerted about.
   */
  | { kind: "summary"; summary: AlertSummary; silent: boolean };

/**
 * Decides what to show for newly added alerts. `added` must already be
 * deduplicated (AlertStore.add) and filtered by preferences.
 *
 * An update is silent only if it comes within `windowMs` of the last
 * notification, the last sound was within `maxSilentMs`, and every added
 * alert is a kind already in the burst and not an approval or failure. So a
 * new kind of event, or anything the user must act on, is always audible, and
 * even a flapping host makes a sound now and then.
 */
export function planNotifications(
  previous: NotificationBurst | null,
  added: readonly TavroAlert[],
  now: number,
  windowMs = NOTIFICATION_BURST_WINDOW_MS,
  maxSilentMs = NOTIFICATION_MAX_SILENT_MS,
): { plan: NotificationPlan | null; burst: NotificationBurst | null } {
  if (!added.length) return { plan: null, burst: previous };
  const summary = summarizeAlerts(added, previous?.summary);
  const [only] = added;
  if (!previous && added.length === 1 && only) {
    return { plan: { kind: "single", alert: only }, burst: { summary, lastShownAt: now, lastAudibleAt: now } };
  }
  const silent =
    previous !== null &&
    now - previous.lastShownAt <= windowMs &&
    now - previous.lastAudibleAt <= maxSilentMs &&
    added.every((a) => !URGENT.has(a.kind) && (previous.summary.counts[a.kind] ?? 0) > 0);
  return {
    plan: { kind: "summary", summary, silent },
    burst: { summary, lastShownAt: now, lastAudibleAt: silent && previous ? previous.lastAudibleAt : now },
  };
}

/** Most urgent first, so a truncated notification still leads with what matters. */
const SUMMARY_ORDER: AlertKind[] = [
  "approval_required",
  "failed",
  "waiting_for_input",
  "completed",
  "host_disconnected",
  "source_unavailable",
  "host_reconnected",
  "source_recovered",
];

const SUMMARY_PHRASE: Record<AlertKind, (n: number) => string> = {
  approval_required: (n) => (n === 1 ? "1 needs approval" : `${n} need approval`),
  failed: (n) => `${n} failed`,
  waiting_for_input: (n) => `${n} waiting for you`,
  completed: (n) => `${n} completed`,
  host_disconnected: (n) => (n === 1 ? "1 host disconnection" : `${n} host disconnections`),
  source_unavailable: (n) => (n === 1 ? "1 session source problem" : `${n} session source problems`),
  host_reconnected: (n) => (n === 1 ? "1 host reconnection" : `${n} host reconnections`),
  source_recovered: (n) => (n === 1 ? "1 session source recovery" : `${n} session source recoveries`),
};

/**
 * Text for a burst summary. Counts per kind only — never names, even when the
 * user opted into names for single notifications (D-013): a summary can't say
 * which name goes with which event in a lock-screen-sized body.
 */
export function alertSummaryText(summary: AlertSummary): { title: string; body: string } {
  const kinds = SUMMARY_ORDER.filter((k) => (summary.counts[k] ?? 0) > 0);
  const [onlyKind] = kinds;
  const demo = summary.total > 0 && summary.allDemo;
  const what = summary.total === 1 && onlyKind ? ALERT_LABEL[onlyKind] : `${summary.total} new alerts`;
  const title = `${demo ? "Tavro demo" : "Tavro"} · ${what}`;
  const parts = kinds.map((k) => SUMMARY_PHRASE[k](summary.counts[k] ?? 0));
  return { title, body: `${parts.join(", ")}.` };
}
