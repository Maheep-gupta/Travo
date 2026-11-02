import { dashboardFilterValues, normalizeSearchQuery, type DashboardFilter } from "@mc/domain";

// Session views, the dashboard filter rules, pairing confirmation and per-session
// alert rules live in @mc/domain so a native client applies them identically.
// What stays here is URL encoding and copy.

/** Field-wise equality for notification preferences (drives the Save button). */
export function prefsEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Writes filters to URL search params, keeping any unrelated params and omitting empty or default ones. */
export function dashboardFilterParams(filter: DashboardFilter, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(dashboardFilterValues(filter))) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
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

/** "1 unread alert", "3 unread alerts". */
export const unreadAlertsLabel = (n: number): string => `${n} unread ${n === 1 ? "alert" : "alerts"}`;
