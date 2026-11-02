import type { ProviderId } from "@mc/contracts";
import { PROVIDERS } from "./capabilities.js";
import {
  DEFAULT_SESSION_SORT,
  isSessionSort,
  matchesFilter,
  normalizeSearchQuery,
  sortSessions,
  type SessionSort,
  type SortableSession,
} from "./sessions.js";
import { STATUS_LABEL, isDisplayStatus, type DisplayStatus } from "./status.js";

/**
 * The session list's overview and filters, shared so every client counts,
 * filters and reads deep links the same way. The URL encoding itself is the
 * client's: filters are read through `FilterParams` and written as plain values.
 */

/** Grouping of display statuses: "Need you" on the dashboard, plus legacy `group` links. */
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

/**
 * Per-state overview counts (spec 3.1), attention states first. Ended and
 * unknown are outside the spec list; clients show them only when present so
 * the chips still add up to the total.
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

/** Dashboard filters and sort, kept in the link so they survive refresh, history and sharing. */
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

/** Same cap as sessions.project_label. */
export const MAX_PROJECT_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProviderId(value: string | null): value is ProviderId {
  return value !== null && Object.hasOwn(PROVIDERS, value);
}

/** Link parameter names, in the order they are written. */
export const DASHBOARD_FILTER_KEYS = ["group", "state", "host", "project", "provider", "q", "sort"] as const;
export type DashboardFilterKey = (typeof DASHBOARD_FILTER_KEYS)[number];

/** Read access to link parameters; a URLSearchParams satisfies it. */
export interface FilterParams {
  get(name: string): string | null;
}

/** Reads filters from link parameters. Unknown or malformed values mean "no filter". */
export function parseDashboardFilter(params: FilterParams): DashboardFilter {
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

/** The value to write for each parameter; null means omit it (empty, or the default sort). */
export function dashboardFilterValues(filter: DashboardFilter): Record<DashboardFilterKey, string | null> {
  return {
    group: filter.group,
    state: filter.state,
    host: filter.host || null,
    project: filter.project || null,
    provider: filter.provider,
    q: normalizeSearchQuery(filter.query) || null,
    sort: filter.sort === DEFAULT_SESSION_SORT ? null : filter.sort,
  };
}

/** Whether any filter (not the sort) narrows the list. */
export function isFiltering(filter: DashboardFilter): boolean {
  return Boolean(filter.group || filter.state || filter.host || filter.project || filter.provider || normalizeSearchQuery(filter.query));
}

/**
 * Applies every filter (they compose) and the chosen sort. A legacy `group`
 * and a `state` that don't overlap match nothing rather than everything.
 */
export function applyDashboardFilter<T extends SortableSession>(views: readonly T[], filter: DashboardFilter): T[] {
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
