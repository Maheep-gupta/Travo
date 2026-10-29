import type { ProviderId, SessionStatus, SessionEventType } from "@mc/contracts";
import { attentionRank, type DisplayStatus } from "./status.js";

export interface SessionFilter {
  statuses?: readonly DisplayStatus[];
  providers?: readonly ProviderId[];
  query?: string;
}

export interface FilterableSession {
  displayStatus: DisplayStatus;
  provider: ProviderId;
  title: string | null;
  project_label: string | null;
  last_event_summary: string | null;
  last_activity_at: string | null;
}

export function matchesFilter(session: FilterableSession, filter: SessionFilter): boolean {
  if (filter.statuses?.length && !filter.statuses.includes(session.displayStatus)) return false;
  if (filter.providers?.length && !filter.providers.includes(session.provider)) return false;
  const q = filter.query?.trim().toLowerCase();
  if (q) {
    const haystack = [session.title, session.project_label, session.last_event_summary]
      .filter((s): s is string => Boolean(s))
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/** Attention first, then most recently active. */
export function compareByAttention(a: FilterableSession, b: FilterableSession): number {
  const rank = attentionRank(a.displayStatus) - attentionRank(b.displayStatus);
  if (rank !== 0) return rank;
  return (Date.parse(b.last_activity_at ?? "") || 0) - (Date.parse(a.last_activity_at ?? "") || 0);
}

export interface ObservedSession {
  external_id: string;
  status: SessionStatus;
}

export interface SessionTransition {
  external_id: string;
  type: SessionEventType;
  status: SessionStatus;
  dedupe_key: string;
}

/**
 * Compares the previously known statuses with a new observation and returns
 * the events to record. Dedupe keys are deterministic per (session, status,
 * observation time) so a retried write cannot create duplicate events.
 */
export function diffObservations(
  previous: ReadonlyMap<string, SessionStatus>,
  current: readonly ObservedSession[],
  observedAt: Date,
): SessionTransition[] {
  const at = observedAt.toISOString();
  const events: SessionTransition[] = [];
  const seen = new Set<string>();
  for (const s of current) {
    seen.add(s.external_id);
    const before = previous.get(s.external_id);
    if (before === undefined) {
      events.push({ external_id: s.external_id, type: "session_discovered", status: s.status, dedupe_key: `discovered` });
    } else if (before !== s.status) {
      events.push({ external_id: s.external_id, type: "status_changed", status: s.status, dedupe_key: `status:${s.status}:${at}` });
    }
  }
  for (const [externalId, before] of previous) {
    if (!seen.has(externalId) && before !== "ended") {
      events.push({ external_id: externalId, type: "session_ended", status: "ended", dedupe_key: `ended:${at}` });
    }
  }
  return events;
}
