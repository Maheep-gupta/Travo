import type { HostRow, PairingTicket, ProviderId, SessionRow } from "@mc/contracts";
import {
  DEFAULT_SESSION_SORT,
  PROVIDERS,
  SEARCH_QUERY_MAX_LENGTH,
  STATUS_LABEL,
  compareByAttention,
  connectivityJudgedAt,
  displayStatus,
  hostConnectivity,
  hostFreshness,
  hostSourceOk,
  isSessionSort,
  matchesFilter,
  normalizeSearchQuery,
  sessionFreshness,
  sortSessions,
  withClientRead,
  type ClientSync,
  type DisplayStatus,
  type Freshness,
  type HostConnectivity,
  type SessionSort,
  type StoredAlert,
} from "@mc/domain";

export interface SessionView extends SessionRow {
  displayStatus: DisplayStatus;
  hostName: string;
  hostConnectivity: HostConnectivity;
  /** When this session's source was last read successfully; separate from last activity. */
  freshness: Freshness;
}

/** How current the client's copy is (from useConnection) and when each list was last fetched (epoch ms; 0 or null = never). */
export interface ClientState {
  sync: ClientSync;
  sessionsFetchedAt: number | null;
  hostsFetchedAt: number | null;
}

/**
 * Joins sessions with their hosts and applies the domain's connectivity rules.
 * Connectivity is judged when the host list was fetched while the client isn't
 * current, so a phone that can't refresh doesn't report healthy hosts as
 * offline; freshness is then capped at the session list's own fetch.
 */
export function buildSessionViews(sessions: readonly SessionRow[], hosts: readonly HostRow[], now: Date, client: ClientState): SessionView[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const judgedAt = connectivityJudgedAt(client.sync, client.hostsFetchedAt, now);
  const read = { sync: client.sync, fetchedAt: client.sessionsFetchedAt };
  return sessions
    .map((s) => {
      const host = byId.get(s.host_id);
      const connectivity: HostConnectivity = host ? hostConnectivity(host, judgedAt) : "disconnected";
      return {
        ...s,
        displayStatus: displayStatus(s.status, connectivity, host ? hostSourceOk(host) : true),
        hostName: host?.name ?? "Unknown host",
        hostConnectivity: connectivity,
        freshness: withClientRead(sessionFreshness(s, host, judgedAt), read, now),
      };
    })
    .sort(compareByAttention);
}

export interface HostView {
  connectivity: HostConnectivity;
  freshness: Freshness;
}

/** One host's connectivity and freshness, judged like buildSessionViews; `fetchedAt` is the host list's. */
export function buildHostView(host: HostRow, now: Date, client: { sync: ClientSync; fetchedAt: number | null }): HostView {
  const judgedAt = connectivityJudgedAt(client.sync, client.fetchedAt, now);
  return { connectivity: hostConnectivity(host, judgedAt), freshness: withClientRead(hostFreshness(host, judgedAt), client, now) };
}

/** Presentation-only grouping of display statuses: "Need you" on the dashboard, plus legacy `group` links. */
export type StatusGroup = "attention" | "working" | "done" | "offline";

export const STATUS_GROUPS: Record<StatusGroup, { label: string; statuses: DisplayStatus[] }> = {
  attention: { label: "Need you", statuses: ["approval_required", "waiting_for_input", "failed"] },
  working: { label: "Working", statuses: ["running"] },
  done: { label: "Done", statuses: ["completed", "ended"] },
  offline: { label: "Offline / unavailable", statuses: ["disconnected", "source_unavailable", "unknown"] },
};

export function isStatusGroup(value: string | null): value is StatusGroup {
  // hasOwn, not `in`: "toString" and other prototype keys are not groups.
  return value !== null && Object.hasOwn(STATUS_GROUPS, value);
}

/** Field-wise equality for notification preferences (drives the Save button). */
export function prefsEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * Per-state overview counts (spec 3.1), attention states first. Ended and
 * unknown are outside the spec list; the dashboard shows them only when present
 * so the chips still add up to the total.
 */
export const OVERVIEW_STATES: readonly DisplayStatus[] = [
  "approval_required",
  "waiting_for_input",
  "failed",
  "running",
  "completed",
  "disconnected",
  "source_unavailable",
];
export const EXTRA_STATES: readonly DisplayStatus[] = ["ended", "unknown"];

export interface StateCounts {
  total: number;
  /** Sessions in the "Need you" group. */
  attention: number;
  byState: Record<DisplayStatus, number>;
}

export function countByState(views: readonly { displayStatus: DisplayStatus }[]): StateCounts {
  const byState = Object.fromEntries(Object.keys(STATUS_LABEL).map((s) => [s, 0])) as Record<DisplayStatus, number>;
  for (const v of views) byState[v.displayStatus] += 1;
  const attention = STATUS_GROUPS.attention.statuses.reduce((n, s) => n + byState[s], 0);
  return { total: views.length, attention, byState };
}

/** Dashboard filters and sort, kept in the URL so they survive refresh and history navigation. */
export interface DashboardFilter {
  /** Older grouped filter; still read so existing links keep working. */
  group: StatusGroup | null;
  state: DisplayStatus | null;
  host: string | null;
  project: string | null;
  provider: ProviderId | null;
  query: string;
  sort: SessionSort;
}

export const EMPTY_DASHBOARD_FILTER: DashboardFilter = {
  group: null,
  state: null,
  host: null,
  project: null,
  provider: null,
  query: "",
  sort: DEFAULT_SESSION_SORT,
};

export const MAX_QUERY_LENGTH = SEARCH_QUERY_MAX_LENGTH;
/** Same cap as sessions.project_label. */
export const MAX_PROJECT_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProviderId(value: string | null): value is ProviderId {
  return value !== null && Object.hasOwn(PROVIDERS, value);
}

export function isDisplayStatus(value: string | null): value is DisplayStatus {
  return value !== null && Object.hasOwn(STATUS_LABEL, value);
}

/** Reads filters from URL search params. Unknown or malformed values mean "no filter". */
export function parseDashboardFilter(params: URLSearchParams): DashboardFilter {
  const group = params.get("group");
  const state = params.get("state");
  const host = params.get("host");
  const project = params.get("project");
  const provider = params.get("provider");
  const sort = params.get("sort");
  return {
    group: isStatusGroup(group) ? group : null,
    state: isDisplayStatus(state) ? state : null,
    // Host ids are uuids; anything else cannot match and is dropped.
    host: host !== null && UUID.test(host) ? host.toLowerCase() : null,
    project: project && project.length <= MAX_PROJECT_LENGTH ? project : null,
    provider: isProviderId(provider) ? provider : null,
    // Trimmed and capped; a query with control characters is dropped.
    query: normalizeSearchQuery(params.get("q")),
    sort: isSessionSort(sort) ? sort : DEFAULT_SESSION_SORT,
  };
}

/** Writes filters back, keeping any unrelated params and omitting empty or default ones. */
export function dashboardFilterParams(filter: DashboardFilter, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
  set("group", filter.group);
  set("state", filter.state);
  set("host", filter.host);
  set("project", filter.project);
  set("provider", filter.provider);
  set("q", normalizeSearchQuery(filter.query) || null);
  set("sort", filter.sort === DEFAULT_SESSION_SORT ? null : filter.sort);
  return next;
}

/** Whether any filter (not the sort) narrows the list. */
export function isFiltering(filter: DashboardFilter): boolean {
  return Boolean(filter.group || filter.state || filter.host || filter.project || filter.provider || normalizeSearchQuery(filter.query));
}

/**
 * Empty-results message naming what is narrowing the list, e.g.
 * `No sessions match the search "deploy" with the filters Failed, docs.`
 */
export function noMatchMessage(query: string, filterLabels: readonly string[]): string {
  const q = normalizeSearchQuery(query);
  const search = q ? `the search "${q}"` : "";
  const filters = filterLabels.length ? `${filterLabels.length === 1 ? "the filter" : "the filters"} ${filterLabels.join(", ")}` : "";
  if (search && filters) return `No sessions match ${search} with ${filters}.`;
  if (search || filters) return `No sessions match ${search || filters}.`;
  return "No sessions match.";
}

/**
 * Applies every filter (they compose) and the chosen sort. A legacy `group`
 * and a `state` that don't overlap match nothing rather than everything.
 */
export function applyDashboardFilter<T extends SessionView>(views: readonly T[], filter: DashboardFilter): T[] {
  let statuses: readonly DisplayStatus[] | undefined;
  if (filter.group && filter.state) {
    if (!STATUS_GROUPS[filter.group].statuses.includes(filter.state)) return [];
    statuses = [filter.state];
  } else if (filter.group) {
    statuses = STATUS_GROUPS[filter.group].statuses;
  } else if (filter.state) {
    statuses = [filter.state];
  }
  const matching = views.filter((s) =>
    matchesFilter(s, {
      statuses,
      providers: filter.provider ? [filter.provider] : undefined,
      hostIds: filter.host ? [filter.host] : undefined,
      projects: filter.project ? [filter.project] : undefined,
      query: filter.query,
    }),
  );
  return sortSessions(matching, filter.sort);
}

/** Distinct project labels, alphabetically, for the project filter. */
export function projectOptions(views: readonly { project_label: string | null }[]): string[] {
  const labels = new Set<string>();
  for (const v of views) if (v.project_label) labels.add(v.project_label);
  return [...labels].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0));
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

/** "1 unread alert", "3 unread alerts". */
export const unreadAlertsLabel = (n: number): string => `${n} unread ${n === 1 ? "alert" : "alerts"}`;

/**
 * Pairing confirmation (spec 11.3): a created code proves nothing, so success
 * is only claimed once the new host has actually heartbeated.
 * - waiting: code not used yet (or the host list hasn't caught up);
 * - paired: the connector exchanged the code but hasn't heartbeated yet;
 * - connected: heartbeating now;
 * - stopped: it heartbeated, but has since stopped reporting;
 * - expired: the code expired unused; revoked: access was revoked meanwhile.
 */
export type PairingStatus = "waiting" | "paired" | "connected" | "stopped" | "expired" | "revoked";

export function pairingStatus(ticket: Pick<PairingTicket, "expires_at">, host: HostRow | undefined, now: Date): PairingStatus {
  if (host) {
    const connectivity = hostConnectivity(host, now);
    if (connectivity === "revoked") return "revoked";
    if (connectivity === "online") return "connected";
    if (connectivity === "disconnected") return "stopped";
    if (host.paired_at) return "paired";
  }
  const expires = Date.parse(ticket.expires_at);
  return !Number.isNaN(expires) && now.getTime() > expires ? "expired" : "waiting";
}

export const PAIRING_POLL_MS = 3_000;
/** Polling stops this long after the code expires, so an abandoned page doesn't poll forever. */
export const PAIRING_POLL_GRACE_MS = 5 * 60_000;

/** How often to re-read hosts while confirming a pairing, or false to stop. */
export function pairingPollInterval(status: PairingStatus, ticket: Pick<PairingTicket, "expires_at">, now: Date): number | false {
  if (status !== "waiting" && status !== "paired") return false;
  const expires = Date.parse(ticket.expires_at);
  if (Number.isNaN(expires)) return false;
  return now.getTime() <= expires + PAIRING_POLL_GRACE_MS ? PAIRING_POLL_MS : false;
}
