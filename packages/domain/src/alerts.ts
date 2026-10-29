import type { NotificationPrefs, SessionStatus } from "@mc/contracts";
import type { HostConnectivity } from "./hosts.js";

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
  | "host_reconnected";

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
};

const ALERT_PREF: Record<AlertKind, keyof NotificationPrefs> = {
  approval_required: "on_approval_required",
  waiting_for_input: "on_waiting_for_input",
  failed: "on_failed",
  completed: "on_completed",
  host_disconnected: "on_host_disconnected",
  host_reconnected: "on_host_reconnected",
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
  is_demo: boolean;
}

/** What detection remembers between runs. */
export interface AlertSnapshot {
  /** Last status observed while the session's host was online (the last trusted status). */
  sessions: ReadonlyMap<string, SessionStatus>;
  hosts: ReadonlyMap<string, HostConnectivity>;
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
 */
export function detectAlerts(
  previous: AlertSnapshot | null,
  sessions: readonly AlertSessionInput[],
  hosts: readonly AlertHostInput[],
): AlertDetection {
  const alerts: TavroAlert[] = [];
  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const hostSnapshot = new Map<string, HostConnectivity>();
  for (const h of hosts) {
    hostSnapshot.set(h.id, h.connectivity);
    const before = previous?.hosts.get(h.id);
    if (!previous || before === undefined || !h.last_seen_at) continue;
    if (before === "online" && h.connectivity === "disconnected") {
      alerts.push({ id: `h:${h.id}:disconnected:${h.last_seen_at}`, kind: "host_disconnected", sessionId: null, hostId: h.id, at: h.last_seen_at, isDemo: h.is_demo });
    } else if (before === "disconnected" && h.connectivity === "online") {
      alerts.push({ id: `h:${h.id}:online:${h.last_seen_at}`, kind: "host_reconnected", sessionId: null, hostId: h.id, at: h.last_seen_at, isDemo: h.is_demo });
    }
  }

  const sessionSnapshot = new Map<string, SessionStatus>();
  for (const s of sessions) {
    const trustedBefore = previous?.sessions.get(s.id);
    if (hostById.get(s.host_id)?.connectivity !== "online") {
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

  return { alerts, snapshot: { sessions: sessionSnapshot, hosts: hostSnapshot } };
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

export function unreadCount(alerts: readonly StoredAlert[]): number {
  return alerts.reduce((n, a) => n + (a.read ? 0 : 1), 0);
}

const KINDS: ReadonlySet<string> = new Set(Object.keys(ALERT_LABEL));
const HOST_KINDS: ReadonlySet<string> = new Set(["host_disconnected", "host_reconnected"]);
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
