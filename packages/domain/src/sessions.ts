import type { ProviderId, SessionStatus, SessionEventType } from "@mc/contracts";
import { attentionRank, type DisplayStatus } from "./status.js";

export interface SessionFilter {
  statuses?: readonly DisplayStatus[];
  providers?: readonly ProviderId[];
  hostIds?: readonly string[];
  projects?: readonly string[];
  query?: string;
}

export interface FilterableSession {
  displayStatus: DisplayStatus;
  provider: ProviderId;
  host_id: string;
  title: string | null;
  project_label: string | null;
  last_activity_at: string | null;
}

/** Empty or missing lists mean "no filter" for that field. */
export function matchesFilter(session: FilterableSession, filter: SessionFilter): boolean {
  if (filter.statuses?.length && !filter.statuses.includes(session.displayStatus)) return false;
  if (filter.providers?.length && !filter.providers.includes(session.provider)) return false;
  if (filter.hostIds?.length && !filter.hostIds.includes(session.host_id)) return false;
  if (filter.projects?.length && (session.project_label === null || !filter.projects.includes(session.project_label))) return false;
  return filter.query === undefined || matchesSearch(session, filter.query);
}

/** Longest search query kept; longer ones are cut to this. */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/** Control characters. A fixed pattern: nothing here is ever built from input. */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * A search query as typed or read from a URL: trimmed and capped. Queries
 * containing control characters aren't something a person types, so they
 * mean "no search" rather than a search for something odd.
 */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  if (!raw || CONTROL_CHARS.test(raw)) return "";
  return raw.trim().slice(0, SEARCH_QUERY_MAX_LENGTH).trim();
}

/**
 * Case- and width-insensitive form for matching: compatibility-normalised
 * (full-width letters, ligatures) and lower-cased without a locale, so every
 * device folds the same way.
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * Text search over the session title and project label (spec 3.3). Every
 * whitespace-separated term must appear in one of the two, so "billing opkey"
 * finds "Refactor billing" in project OpkeyStack. Plain substring checks, no
 * pattern syntax, so any input is safe. A blank query matches everything.
 */
export function matchesSearch(session: Pick<FilterableSession, "title" | "project_label">, query: string): boolean {
  const terms = foldForSearch(normalizeSearchQuery(query)).split(/\s+/u).filter(Boolean);
  if (!terms.length) return true;
  const fields = [session.title, session.project_label].filter((s): s is string => Boolean(s)).map(foldForSearch);
  return terms.every((t) => fields.some((f) => f.includes(t)));
}

/** What the sort orders need: filter fields plus a stable id and the host's display name. */
export interface SortableSession extends FilterableSession {
  id: string;
  hostName: string;
}

/** Missing or malformed times sort as the oldest. */
function activityTime(s: { last_activity_at: string | null }): number {
  return Date.parse(s.last_activity_at ?? "") || 0;
}

const byRecent = (a: SortableSession, b: SortableSession): number => activityTime(b) - activityTime(a);

/** Code-unit order, not locale order, so the final tie-break is identical on every device. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Case-insensitive label order with a code-unit fallback; missing labels go last. */
function byLabel(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, "en", { sensitivity: "base" }) || byCodeUnit(a, b);
}

/** Attention first, then most recently active, then id. */
export function compareByAttention(a: SortableSession, b: SortableSession): number {
  return attentionRank(a.displayStatus) - attentionRank(b.displayStatus) || byRecent(a, b) || byCodeUnit(a.id, b.id);
}

/** Most recently active first, then id. */
export function compareByRecent(a: SortableSession, b: SortableSession): number {
  return byRecent(a, b) || byCodeUnit(a.id, b.id);
}

/** Working sessions first, then everything else in attention order. */
export function compareWorkingFirst(a: SortableSession, b: SortableSession): number {
  return Number(b.displayStatus === "running") - Number(a.displayStatus === "running") || compareByAttention(a, b);
}

const FINISHED: ReadonlySet<DisplayStatus> = new Set(["completed", "ended"]);

/** Completed and ended sessions first, newest first; then the rest by recent activity. */
export function compareRecentlyCompleted(a: SortableSession, b: SortableSession): number {
  return Number(FINISHED.has(b.displayStatus)) - Number(FINISHED.has(a.displayStatus)) || compareByRecent(a, b);
}

/** Grouped by host name (host id splits same-named hosts), attention order within a host. */
export function compareByHost(a: SortableSession, b: SortableSession): number {
  return byLabel(a.hostName, b.hostName) || byCodeUnit(a.host_id, b.host_id) || compareByAttention(a, b);
}

/** Grouped by project (sessions without one last), attention order within a project. */
export function compareByProject(a: SortableSession, b: SortableSession): number {
  return byLabel(a.project_label, b.project_label) || compareByAttention(a, b);
}

export type SessionSort = "attention" | "recent" | "working" | "completed" | "host" | "project";

/** Every comparator ends in the id tie-break, so equal timestamps still give one order. */
export const SESSION_SORTS: Record<SessionSort, { label: string; compare: (a: SortableSession, b: SortableSession) => number }> = {
  attention: { label: "Needs attention first", compare: compareByAttention },
  recent: { label: "Most recently active", compare: compareByRecent },
  working: { label: "Working first", compare: compareWorkingFirst },
  completed: { label: "Recently completed", compare: compareRecentlyCompleted },
  host: { label: "Host", compare: compareByHost },
  project: { label: "Project", compare: compareByProject },
};

export const DEFAULT_SESSION_SORT: SessionSort = "attention";

export function isSessionSort(value: string | null): value is SessionSort {
  // hasOwn, not `in`: prototype keys such as "toString" are not sorts.
  return value !== null && Object.hasOwn(SESSION_SORTS, value);
}

/** Returns a new array in the given order; the input is left untouched. */
export function sortSessions<T extends SortableSession>(sessions: readonly T[], sort: SessionSort): T[] {
  return [...sessions].sort(SESSION_SORTS[sort].compare);
}

export interface HostSessionSummary {
  count: number;
  /** Latest last_activity_at among the host's sessions; null when none is known. */
  lastActivityAt: string | null;
}

/** Session count and latest activity per host id. Hosts without sessions are absent. */
export function summariseByHost(sessions: readonly { host_id: string; last_activity_at: string | null }[]): Map<string, HostSessionSummary> {
  const out = new Map<string, HostSessionSummary>();
  for (const s of sessions) {
    const prev = out.get(s.host_id) ?? { count: 0, lastActivityAt: null };
    const later = activityTime(s) > activityTime({ last_activity_at: prev.lastActivityAt }) ? s.last_activity_at : prev.lastActivityAt;
    out.set(s.host_id, { count: prev.count + 1, lastActivityAt: later });
  }
  return out;
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
