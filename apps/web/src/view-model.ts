import type { HostRow, SessionRow } from "@mc/contracts";
import { compareByAttention, displayStatus, hostConnectivity, type DisplayStatus, type HostConnectivity } from "@mc/domain";

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
  return value !== null && value in STATUS_GROUPS;
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
