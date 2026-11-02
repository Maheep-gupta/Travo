import type { HostRow, ProviderId, SessionRow } from "@mc/contracts";
import {
  DEFAULT_SESSION_SORT,
  PROVIDERS,
  STATUS_LABEL,
  compareByAttention,
  displayStatus,
  hostConnectivity,
  hostSourceOk,
  isSessionSort,
  matchesFilter,
  sortSessions,
  type DisplayStatus,
  type HostConnectivity,
  type SessionSort,
} from "@mc/domain";

export interface SessionView extends SessionRow {
  displayStatus: DisplayStatus;
  hostName: string;
  hostConnectivity: HostConnectivity;
}

/** Joins sessions with their hosts and applies the domain's connectivity rules. */
export function buildSessionViews(sessions: readonly SessionRow[], hosts: readonly HostRow[], now: Date): SessionView[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return sessions
    .map((s) => {
      const host = byId.get(s.host_id);
      const connectivity: HostConnectivity = host ? hostConnectivity(host, now) : "disconnected";
      return {
        ...s,
        displayStatus: displayStatus(s.status, connectivity, host ? hostSourceOk(host) : true),
        hostName: host?.name ?? "Unknown host",
        hostConnectivity: connectivity,
      };
    })
    .sort(compareByAttention);
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

export const MAX_QUERY_LENGTH = 200;
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
    query: (params.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
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
  set("q", filter.query.trim() ? filter.query.slice(0, MAX_QUERY_LENGTH) : null);
  set("sort", filter.sort === DEFAULT_SESSION_SORT ? null : filter.sort);
  return next;
}

/** Whether any filter (not the sort) narrows the list. */
export function isFiltering(filter: DashboardFilter): boolean {
  return Boolean(filter.group || filter.state || filter.host || filter.project || filter.provider || filter.query.trim());
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
