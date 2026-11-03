import type { NotificationPrefs, SessionStatus } from "@mc/contracts";
import { DISCONNECT_AFTER_MS, type HostConnectivity } from "./hosts.js";

/**
 * Tavro Alerts: attention events derived by comparing successive snapshots of
 * sessions and hosts. Pure and platform-neutral so the web app and the future
 * mobile app detect exactly the same events.
 *
 * Alerts carry identifiers only — never titles, summaries or transcript text —
 * so they are safe to persist locally and to put in system notifications.
 */
export type AlertKind =
  | "approval_required"
  | "waiting_for_input"
  | "failed"
  | "completed"
  | "host_disconnected"
  | "host_reconnected"
  | "source_unavailable"
  | "source_recovered";

export interface TavroAlert {
  /** Deterministic: the same underlying event always yields the same id. */
  id: string;
  kind: AlertKind;
  /** Null for host alerts. */
  sessionId: string | null;
  hostId: string;
  /** ISO time of the underlying event (best available), not of detection. */
  at: string;
  isDemo: boolean;
}

export interface StoredAlert extends TavroAlert {
  read: boolean;
}

export const ALERT_LABEL: Record<AlertKind, string> = {
  approval_required: "Needs approval",
  waiting_for_input: "Waiting for you",
  failed: "Failed",
  completed: "Completed",
  host_disconnected: "Host disconnected",
  host_reconnected: "Host reconnected",
  source_unavailable: "Session source not responding",
  source_recovered: "Session source recovered",
};

/**
 * Source-health alerts follow the host connectivity preferences: both mean
 * "statuses from this machine can't be trusted right now" / "they can again",
 * and reusing them avoids a notification_prefs schema change.
 */
const ALERT_PREF: Record<AlertKind, keyof NotificationPrefs> = {
  approval_required: "on_approval_required",
  waiting_for_input: "on_waiting_for_input",
  failed: "on_failed",
  completed: "on_completed",
  host_disconnected: "on_host_disconnected",
  host_reconnected: "on_host_reconnected",
  source_unavailable: "on_host_disconnected",
  source_recovered: "on_host_reconnected",
};

export function alertAllowed(kind: AlertKind, prefs: NotificationPrefs): boolean {
  return prefs[ALERT_PREF[kind]];
}

const SESSION_ALERT_KINDS: ReadonlySet<SessionStatus> = new Set(["approval_required", "waiting_for_input", "failed", "completed"]);
/** A session first seen in one of these states is worth an alert; idle new sessions are not. */
const NEW_SESSION_ALERT_KINDS: ReadonlySet<SessionStatus> = new Set(["approval_required", "failed"]);

export interface AlertSessionInput {
  id: string;
  host_id: string;
  status: SessionStatus;
  last_activity_at: string | null;
  updated_at: string;
  is_demo: boolean;
}

export interface AlertHostInput {
  id: string;
  connectivity: HostConnectivity;
  last_seen_at: string | null;
  /** Schema v2: null while the session source is healthy. */
  provider_error_since: string | null;
  is_demo: boolean;
}

/** What detection remembers between runs. */
export interface AlertSnapshot {
  /** Last status observed while the session's host was online (the last trusted status). */
  sessions: ReadonlyMap<string, SessionStatus>;
  hosts: ReadonlyMap<string, HostConnectivity>;
  /** Source health per host, recorded only while the host was online (otherwise unknown). */
  sources: ReadonlyMap<string, boolean>;
  /** When the hosts of this snapshot were fetched (client clock, epoch ms); null if not given. */
  observedAt: number | null;
  /** First fetch after the client's own last gap (sleep, frozen tab); null if there was none. */
  watchingSince: number | null;
  /**
   * Hosts whose disconnection the sleep grace is holding back: the last_seen_at
   * it was granted for, and the watch (watchingSince) that granted it.
   */
  graced: ReadonlyMap<string, { lastSeenAt: string; watchingSince: number }>;
}

export interface AlertDetection {
  alerts: TavroAlert[];
  snapshot: AlertSnapshot;
}

/**
 * Compares the current observation with the previous snapshot.
 *
 * - `previous === null` is the baseline: nothing is alerted, so opening the app
 *   never floods the user with alerts for states that already existed.
 * - A session's stored status is only trusted while its host is online. Behind
 *   an offline host the last trusted status is carried forward and nothing is
 *   alerted; if the status changed during the outage, the alert fires once the
 *   host is back, and an unchanged status produces no alert.
 * - Hosts alert on online → disconnected and disconnected → online only. First
 *   connections and revocations are not attention events.
 * - Session source health (e.g. the Claude CLI failing while the host still
 *   heartbeats) alerts on ok → failing and failing → ok, judged only while the
 *   host is online. Sessions behind a failing source are untrusted exactly
 *   like sessions behind an offline host.
 * - With `observedAt` (when the host list was fetched), a client that wasn't
 *   fetching for longer than DISCONNECT_AFTER_MS — its own machine slept, or
 *   the tab was frozen — can't tell whether a host went quiet while it was
 *   watching or merely slept too (a closed lid suspends both). Such a
 *   disconnection is alerted only if the host stays silent for another
 *   DISCONNECT_AFTER_MS after the client resumed; a host that reports within
 *   that grace raises neither alert. Its sessions stay untrusted meanwhile.
 *   The grace is granted once per host and last heartbeat: if a later gap
 *   ends with the host still on the same last_seen_at, it is alerted at once,
 *   so a phone opened briefly every few minutes still hears of a dead laptop.
 */
export function detectAlerts(
  previous: AlertSnapshot | null,
  sessions: readonly AlertSessionInput[],
  hosts: readonly AlertHostInput[],
  observedAt?: Date,
): AlertDetection {
  const alerts: TavroAlert[] = [];
  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const fetchedAt = observedAt ? observedAt.getTime() : null;
  const lastFetchedAt = previous?.observedAt ?? null;
  // A gap longer than the disconnect window, or a clock that stepped back, restarts the watch.
  const gap = fetchedAt !== null && lastFetchedAt !== null && (fetchedAt < lastFetchedAt || fetchedAt - lastFetchedAt > DISCONNECT_AFTER_MS);
  const watchingSince = gap ? fetchedAt : (previous?.watchingSince ?? null);
  const inGrace = fetchedAt !== null && watchingSince !== null && fetchedAt - watchingSince < DISCONNECT_AFTER_MS;

  const hostSnapshot = new Map<string, HostConnectivity>();
  const sourceSnapshot = new Map<string, boolean>();
  const gracedSnapshot = new Map<string, { lastSeenAt: string; watchingSince: number }>();
  for (const h of hosts) {
    hostSnapshot.set(h.id, h.connectivity);
    if (h.connectivity === "online") {
      const sourceOk = h.provider_error_since === null;
      sourceSnapshot.set(h.id, sourceOk);
      const sourceBefore = previous?.sources.get(h.id);
      // "online" implies a heartbeat, so last_seen_at is set; a failing source has its start time.
      const at = (sourceOk ? h.last_seen_at : h.provider_error_since) ?? h.last_seen_at;
      if (previous && sourceBefore !== undefined && sourceBefore !== sourceOk && at) {
        alerts.push({
          id: `src:${h.id}:${sourceOk ? "ok" : "down"}:${at}`,
          kind: sourceOk ? "source_recovered" : "source_unavailable",
          sessionId: null,
          hostId: h.id,
          at,
          isDemo: h.is_demo,
        });
      }
    } else {
      // Unknown while offline: keep what we last knew.
      const known = previous?.sources.get(h.id);
      if (known !== undefined) sourceSnapshot.set(h.id, known);
    }
    const before = previous?.hosts.get(h.id);
    if (!previous || before === undefined || !h.last_seen_at) continue;
    if (before === "online" && h.connectivity === "disconnected") {
      const granted = previous.graced.get(h.id);
      // Graced for this same heartbeat during an earlier watch: it had its chance.
      const spent = granted !== undefined && granted.lastSeenAt === h.last_seen_at && granted.watchingSince !== watchingSince;
      if (inGrace && watchingSince !== null && !spent) {
        // Not yet: it may have slept with us. Remember it as online so the alert still fires after the grace.
        hostSnapshot.set(h.id, "online");
        gracedSnapshot.set(h.id, { lastSeenAt: h.last_seen_at, watchingSince });
      } else alerts.push({ id: `h:${h.id}:disconnected:${h.last_seen_at}`, kind: "host_disconnected", sessionId: null, hostId: h.id, at: h.last_seen_at, isDemo: h.is_demo });
    } else if (before === "disconnected" && h.connectivity === "online") {
      alerts.push({ id: `h:${h.id}:online:${h.last_seen_at}`, kind: "host_reconnected", sessionId: null, hostId: h.id, at: h.last_seen_at, isDemo: h.is_demo });
    }
  }

  const sessionSnapshot = new Map<string, SessionStatus>();
  for (const s of sessions) {
    const trustedBefore = previous?.sessions.get(s.id);
    const host = hostById.get(s.host_id);
    if (host?.connectivity !== "online" || host.provider_error_since !== null) {
      // Untrusted right now: alert on nothing. Keep what we knew; a session we
      // have not seen yet is recorded with its stored status, so an unchanged
      // status is not mistaken for a new event once the host is back.
      sessionSnapshot.set(s.id, trustedBefore ?? s.status);
      continue;
    }
    sessionSnapshot.set(s.id, s.status);
    if (!previous || trustedBefore === s.status) continue;
    const relevant = trustedBefore === undefined ? NEW_SESSION_ALERT_KINDS : SESSION_ALERT_KINDS;
    if (!relevant.has(s.status)) continue;
    const at = s.last_activity_at ?? s.updated_at;
    alerts.push({ id: `s:${s.id}:${s.status}:${at}`, kind: s.status as AlertKind, sessionId: s.id, hostId: s.host_id, at, isDemo: s.is_demo });
  }

  return { alerts, snapshot: { sessions: sessionSnapshot, hosts: hostSnapshot, sources: sourceSnapshot, observedAt: fetchedAt, watchingSince, graced: gracedSnapshot } };
}

export const MAX_STORED_ALERTS = 50;

/**
 * Adds new alerts to the stored list: duplicates (by id) are ignored and the
 * list is capped. Newly detected alerts go first (newest event first among
 * them), so an alert about an older event — e.g. reported after a host
 * outage — is never evicted the moment it arrives. Returns the same array
 * when nothing changed.
 */
export function mergeAlerts(existing: readonly StoredAlert[], incoming: readonly TavroAlert[], max = MAX_STORED_ALERTS): readonly StoredAlert[] {
  const known = new Set(existing.map((a) => a.id));
  const fresh: StoredAlert[] = [];
  for (const a of incoming) {
    if (known.has(a.id)) continue;
    known.add(a.id);
    fresh.push({ ...a, read: false });
  }
  if (!fresh.length) return existing;
  fresh.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return [...fresh, ...existing].slice(0, max);
}

/** Alerts about one session, newest event first (unparseable times last). */
export function sessionAlerts(alerts: readonly StoredAlert[], sessionId: string): StoredAlert[] {
  const time = (a: StoredAlert) => Date.parse(a.at) || 0;
  return alerts.filter((a) => a.sessionId === sessionId).sort((a, b) => time(b) - time(a));
}

/** Unread alert count per session id, for the dashboard cards. Host alerts (no session) are not counted. */
export function unreadBySession(alerts: readonly StoredAlert[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of alerts) if (!a.read && a.sessionId) out.set(a.sessionId, (out.get(a.sessionId) ?? 0) + 1);
  return out;
}

export function unreadCount(alerts: readonly StoredAlert[]): number {
  return alerts.reduce((n, a) => n + (a.read ? 0 : 1), 0);
}

const KINDS: ReadonlySet<string> = new Set(Object.keys(ALERT_LABEL));
const HOST_KINDS: ReadonlySet<string> = new Set(["host_disconnected", "host_reconnected", "source_unavailable", "source_recovered"]);
/** Database ids are UUIDs; demo ids follow the same shape. Anything else is tampering. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** Validates alerts read back from local storage; malformed entries are dropped. */
export function parseStoredAlerts(raw: unknown): StoredAlert[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredAlert[] = [];
  for (const v of raw as unknown[]) {
    if (typeof v !== "object" || v === null) continue;
    const a = v as Record<string, unknown>;
    if (
      typeof a.id === "string" &&
      a.id.length <= 300 &&
      typeof a.kind === "string" &&
      KINDS.has(a.kind) &&
      // Host alerts have no session; session alerts must have a well-formed one.
      (HOST_KINDS.has(a.kind) ? a.sessionId === null : typeof a.sessionId === "string" && ID.test(a.sessionId)) &&
      typeof a.hostId === "string" &&
      ID.test(a.hostId) &&
      typeof a.at === "string" &&
      !Number.isNaN(Date.parse(a.at)) &&
      typeof a.isDemo === "boolean" &&
      typeof a.read === "boolean"
    ) {
      out.push({ id: a.id, kind: a.kind as AlertKind, sessionId: a.sessionId as string | null, hostId: a.hostId, at: a.at, isDemo: a.isDemo, read: a.read });
    }
  }
  return out.slice(0, MAX_STORED_ALERTS);
}

const NOTIFICATION_BODY: Record<AlertKind, string> = {
  approval_required: "A session is waiting for your approval.",
  waiting_for_input: "A session finished its turn and is waiting for you.",
  failed: "A session reported a failure.",
  completed: "A session reported that it is done.",
  host_disconnected: "A host stopped reporting. Its sessions may be out of date.",
  host_reconnected: "A host is reporting again.",
  source_unavailable: "A host can't read its sessions right now. Their status may be out of date.",
  source_recovered: "A host can read its sessions again.",
};

/** Names shown only when the user opted in on this device (D-013). */
export interface AlertNotificationNames {
  session?: string | null;
  host?: string | null;
}

export const MAX_NOTIFICATION_NAME_LENGTH = 80;

// C0/C1 controls and bidi overrides/isolates: a name must not be able to
// reorder or fake lines in the notification.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function notificationName(value: string | null | undefined): string | null {
  const v = value?.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!v) return null;
  const chars = Array.from(v); // code points, so emoji are never split
  return chars.length > MAX_NOTIFICATION_NAME_LENGTH ? `${chars.slice(0, MAX_NOTIFICATION_NAME_LENGTH - 1).join("")}…` : v;
}

/**
 * Text for an OS-level notification. Generic by default: no session titles,
 * project names or summaries, because notifications can appear on a lock
 * screen and in OS notification history. Names are added only when passed,
 * i.e. when the user turned that on for this device. Summaries and
 * transcript text are never included.
 */
export function alertNotificationText(alert: Pick<TavroAlert, "kind" | "isDemo">, names?: AlertNotificationNames): { title: string; body: string } {
  const title = `${alert.isDemo ? "Tavro demo" : "Tavro"} · ${ALERT_LABEL[alert.kind]}`;
  const generic = NOTIFICATION_BODY[alert.kind];
  const session = notificationName(names?.session);
  const host = notificationName(names?.host);
  const where = [session, host].filter(Boolean).join(" · ");
  return { title, body: where ? `${where}\n${generic}` : generic };
}
