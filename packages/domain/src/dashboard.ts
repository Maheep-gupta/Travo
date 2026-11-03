import type { HostRow, ProviderId } from "@mc/contracts";
import { PROVIDERS } from "./capabilities.js";
import type { ConnectionState } from "./connectivity.js";
import type { RefreshFailure } from "./data-availability.js";
import type { ClientSync } from "./freshness.js";
import { hostSourceOk } from "./hosts.js";
import { buildHostView } from "./session-views.js";
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

/**
 * Hosts whose sessions' statuses can be trusted right now: online with a
 * working source, judged like the Hosts page. Null when the host list
 * couldn't be loaded, so nothing is known.
 */
export function trustedHostCount(hosts: readonly HostRow[] | null, now: Date, client: { sync: ClientSync; fetchedAt: number | null }): number | null {
  if (hosts === null) return null;
  return hosts.filter((h) => hostSourceOk(h) && buildHostView(h, now, client).connectivity === "online").length;
}

export interface HeadlineInput {
  /** Overview counts of the sessions on screen; null while none have loaded. */
  counts: StateCounts | null;
  /** How current the statuses are; a failed refresh counts as not current (syncWithRefreshes). */
  sync: ClientSync;
  /** From trustedHostCount. */
  trustedHosts: number | null;
}

const needYou = (n: number) => (n === 0 ? "nothing needs you" : n === 1 ? "1 session needs you" : `${n} sessions need you`);

/**
 * The dashboard headline (spec 3.1: no misleading aggregates). "All clear"
 * only when the counts are current, at least one host is vouching for its
 * sessions, and no session on screen is disconnected, behind a failing source
 * or unknown; otherwise it says what was last known and that it can't be
 * confirmed, never that nothing needs the user.
 */
export function dashboardHeadline({ counts, sync, trustedHosts }: HeadlineInput): string {
  if (!counts) return "Sessions";
  if (sync !== "current") return counts.total === 0 ? "Can't confirm right now — last known: no sessions." : `Can't confirm right now — last known: ${needYou(counts.attention)}.`;
  if (counts.total === 0) return "No sessions yet";
  if (trustedHosts === null) return `Statuses can't be confirmed — last reported: ${needYou(counts.attention)}.`;
  if (trustedHosts === 0) return "Statuses can't be confirmed — no host is reporting normally.";
  if (counts.attention === 0) {
    // Sessions behind an offline host or failing source can't vouch for themselves, even when another host can.
    const unconfirmed = STATUS_GROUPS.offline.statuses.reduce((n, s) => n + counts.byState[s], 0);
    if (unconfirmed > 0) return `Nothing confirmed needs you — ${unconfirmed === 1 ? "1 session" : `${unconfirmed} sessions`} can't be confirmed.`;
    return "All clear. Nothing needs you.";
  }
  return counts.attention === 1 ? "1 session needs you." : `${counts.attention} sessions need you.`;
}

/** When the overview's counts are from while they aren't current (epoch ms); null while they are, or if unknown. */
export function countsAsOf(connection: ConnectionState, refresh: RefreshFailure | null): number | null {
  if (connection.kind !== "current") return connection.dataFrom;
  return refresh?.dataFrom ?? null;
}

/**
 * States only the host list can put a session in: Disconnected (its host
 * stopped heartbeating) and Source not responding (its host can't read its
 * sessions). Without the host list no session is counted there, so a "0" for
 * them would be a confident claim nothing supports (spec 3.1).
 */
export const HOST_DERIVED_STATES: readonly DisplayStatus[] = ["disconnected", "source_unavailable"];

/**
 * The overview counts that are unknown rather than zero: the host-derived
 * states while the host list is missing (failed, or not loaded yet). A host
 * list whose refresh failed still counts: its counts are as of that fetch.
 */
export function unknownStateCounts({ hostsLoaded }: { hostsLoaded: boolean }): ReadonlySet<DisplayStatus> {
  return new Set(hostsLoaded ? [] : HOST_DERIVED_STATES);
}

const UNKNOWN_STATE_SUBJECT: Partial<Record<DisplayStatus, string>> = {
  disconnected: "which sessions are disconnected",
  source_unavailable: "which sessions' hosts can't read them",
};

/**
 * What an empty list filtered to an unknown state says instead of "nothing
 * matches", which would be the confident claim its chip's "–" avoids. Null
 * for a state whose count is known.
 */
export function unknownStateMessage(state: DisplayStatus | null, unknown: ReadonlySet<DisplayStatus>): string | null {
  if (state === null || !unknown.has(state)) return null;
  return `Host status isn't loaded, so Tavro can't tell ${UNKNOWN_STATE_SUBJECT[state] ?? "which sessions are in this state"} right now.`;
}

/**
 * Navigation state a dashboard session link carries, so the session's back
 * link returns to the same filtered list (spec 3.3). Only the search is
 * stored; the path is always the dashboard's.
 */
export interface DashboardOrigin {
  dashboardOrigin: { pathname: "/"; search: string };
}

export function dashboardOrigin(search: string): DashboardOrigin {
  return { dashboardOrigin: { pathname: "/", search } };
}

/** Longer than any link the filters write (a project label is capped at 200). */
export const DASHBOARD_ORIGIN_MAX_LENGTH = 2048;
/** Empty, or "?" and a query with no fragment or whitespace. */
const ORIGIN_SEARCH = /^(\?[^#\s]*)?$/;

/**
 * The dashboard link to go back to, read from untrusted navigation state
 * (history entries outlive the code that wrote them). Only the dashboard
 * path with a search string is accepted, so the result can never point
 * anywhere else; null when the state isn't a valid origin.
 */
export function dashboardReturnPath(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !Object.hasOwn(state, "dashboardOrigin")) return null;
  const origin: unknown = (state as { dashboardOrigin: unknown }).dashboardOrigin;
  if (typeof origin !== "object" || origin === null) return null;
  const { pathname, search } = origin as { pathname?: unknown; search?: unknown };
  if (pathname !== "/" || typeof search !== "string") return null;
  if (search.length > DASHBOARD_ORIGIN_MAX_LENGTH || !ORIGIN_SEARCH.test(search)) return null;
  // A bare "?" is the dashboard with no filters.
  return search.length > 1 ? `/${search}` : "/";
}
