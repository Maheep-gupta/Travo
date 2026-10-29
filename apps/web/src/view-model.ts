import type { HostRow, ProviderId, SessionRow } from "@mc/contracts";
import { PROVIDERS, compareByAttention, displayStatus, hostConnectivity, type DisplayStatus, type HostConnectivity } from "@mc/domain";

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
        displayStatus: displayStatus(s.status, connectivity),
        hostName: host?.name ?? "Unknown host",
        hostConnectivity: connectivity,
      };
    })
    .sort(compareByAttention);
}

/** Dashboard overview buckets. Presentation-only grouping of display statuses. */
export type StatusGroup = "attention" | "working" | "done" | "offline";

export const STATUS_GROUPS: Record<StatusGroup, { label: string; statuses: DisplayStatus[] }> = {
  attention: { label: "Need you", statuses: ["approval_required", "waiting_for_input", "failed"] },
  working: { label: "Working", statuses: ["running"] },
  done: { label: "Done", statuses: ["completed", "ended"] },
  offline: { label: "Offline / unknown", statuses: ["disconnected", "unknown"] },
};

export function isStatusGroup(value: string | null): value is StatusGroup {
  // hasOwn, not `in`: "toString" and other prototype keys are not groups.
  return value !== null && Object.hasOwn(STATUS_GROUPS, value);
}

export function countByGroup(views: readonly { displayStatus: DisplayStatus }[]): Record<StatusGroup, number> {
  const counts: Record<StatusGroup, number> = { attention: 0, working: 0, done: 0, offline: 0 };
  for (const v of views) {
    for (const [group, def] of Object.entries(STATUS_GROUPS) as [StatusGroup, (typeof STATUS_GROUPS)[StatusGroup]][]) {
      if (def.statuses.includes(v.displayStatus)) counts[group] += 1;
    }
  }
  return counts;
}

/** Field-wise equality for notification preferences (drives the Save button). */
export function prefsEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Dashboard filters, kept in the URL so they survive refresh and history navigation. */
export interface DashboardFilter {
  group: StatusGroup | null;
  provider: ProviderId | null;
  query: string;
}

export const MAX_QUERY_LENGTH = 200;

function isProviderId(value: string | null): value is ProviderId {
  return value !== null && Object.hasOwn(PROVIDERS, value);
}

/** Reads filters from URL search params. Unknown or malformed values mean "no filter". */
export function parseDashboardFilter(params: URLSearchParams): DashboardFilter {
  const group = params.get("group");
  const provider = params.get("provider");
  return {
    group: isStatusGroup(group) ? group : null,
    provider: isProviderId(provider) ? provider : null,
    query: (params.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
  };
}

/** Writes filters back, keeping any unrelated params and omitting empty ones. */
export function dashboardFilterParams(filter: DashboardFilter, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
  set("group", filter.group);
  set("provider", filter.provider);
  set("q", filter.query.trim() ? filter.query.slice(0, MAX_QUERY_LENGTH) : null);
  return next;
}
