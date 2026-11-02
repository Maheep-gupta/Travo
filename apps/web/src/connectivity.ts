// Whether the data on screen is current (spec 3.5, 14.2), and what the
// offline banner says when it isn't. Pure: the shell feeds in the browser's
// online flag and timestamps read from the TanStack Query cache, so no extra
// requests are made just to find out whether we are connected.
import { STALE_DATA_AFTER_MS } from "@mc/domain";

/**
 * Data older than this is no longer presented as live. The host and session
 * lists are polled every heartbeat (30 s, also in background tabs), so this is
 * three missed polls: the same budget after which a host counts as disconnected.
 * Defined in the domain so session and host freshness use the same threshold.
 */
export { STALE_DATA_AFTER_MS };

/**
 * A fetch that is still running gets this long before stale data is reported,
 * so resuming a frozen tab doesn't flash a warning while the refetch is on its way.
 */
export const FETCH_GRACE_MS = 15_000;

/** What the query cache says about the data the dashboard depends on. Times are epoch ms; null = never. */
export interface FetchSummary {
  /** The OLDEST latest success among those queries: the age of the stalest data on screen. */
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** When the current run of in-flight fetches began; null when nothing is fetching. */
  fetchingSince: number | null;
}

export type ConnectionState =
  | { kind: "current" }
  /** The browser reports no network. */
  | { kind: "offline"; dataFrom: number | null }
  /** Fetches are failing. */
  | { kind: "unreachable"; dataFrom: number }
  /** Nothing has failed, but nothing has refreshed the data either. */
  | { kind: "stale"; dataFrom: number };

export function connectionState(online: boolean, f: FetchSummary, now: number): ConnectionState {
  if (!online) return { kind: "offline", dataFrom: f.lastSuccessAt };
  // Nothing loaded yet: pages show their own loading and error states.
  if (f.lastSuccessAt === null || now - f.lastSuccessAt <= STALE_DATA_AFTER_MS) return { kind: "current" };
  if (f.lastFailureAt !== null && f.lastFailureAt > f.lastSuccessAt) return { kind: "unreachable", dataFrom: f.lastSuccessAt };
  if (f.fetchingSince !== null && now - f.fetchingSince < FETCH_GRACE_MS) return { kind: "current" };
  return { kind: "stale", dataFrom: f.lastSuccessAt };
}

/** The subset of a TanStack Query we read; a real Query satisfies it. */
export interface QueryLike {
  readonly queryKey: readonly unknown[];
  readonly state: { readonly dataUpdatedAt: number; readonly errorUpdatedAt: number; readonly fetchStatus: string };
}

/**
 * The queries every status on screen is built from: the host list and the
 * session list (userKey shapes [scope, backend, userId, ...rest]). Session
 * events, messages and preferences don't make a status current or stale.
 */
export function isStatusQuery(key: readonly unknown[], userId: string): boolean {
  if (key[2] !== userId) return false;
  return (key[0] === "hosts" && key.length === 3) || (key[0] === "sessions" && key[3] === "list" && key.length === 4);
}

/**
 * Fetch history of one user's status queries. The success time is the OLDEST
 * of their latest successes, so a fresh host list can't hide a session list
 * that stopped refreshing. Failures are the latest of any of them. Paused
 * fetches (waiting for the network) don't count as fetching.
 */
export function summarizeQueries(queries: Iterable<QueryLike>, userId: string): { lastSuccessAt: number | null; lastFailureAt: number | null; fetching: boolean } {
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let fetching = false;
  for (const q of queries) {
    if (!isStatusQuery(q.queryKey, userId)) continue;
    const { dataUpdatedAt, errorUpdatedAt, fetchStatus } = q.state;
    // A query that never succeeded has nothing on screen; its page shows its own loading or error state.
    if (dataUpdatedAt > 0 && (lastSuccessAt === null || dataUpdatedAt < lastSuccessAt)) lastSuccessAt = dataUpdatedAt;
    if (errorUpdatedAt > 0 && (lastFailureAt === null || errorUpdatedAt > lastFailureAt)) lastFailureAt = errorUpdatedAt;
    if (fetchStatus === "fetching") fetching = true;
  }
  return { lastSuccessAt, lastFailureAt, fetching };
}

/** "14:05", or "3 Nov, 14:05" when the data is from another day. */
export function formatDataTime(at: number, now: number, locale?: string, timeZone?: string): string {
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone };
  const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(ms);
  if (day(at) === day(now)) return new Intl.DateTimeFormat(locale, time).format(at);
  return new Intl.DateTimeFormat(locale, { ...time, day: "numeric", month: "short" }).format(at);
}

/** Banner text, or null when the data is current. Never claims the data is live. */
export function connectionMessage(f: ConnectionState, formatTime: (at: number) => string): { title: string; detail: string } | null {
  switch (f.kind) {
    case "current":
      return null;
    case "offline":
      return f.dataFrom === null
        ? { title: "Offline", detail: "Tavro will load your data when you're back online." }
        : { title: `Offline — showing data from ${formatTime(f.dataFrom)}`, detail: "Statuses may have changed since then. Tavro updates when you're back online." };
    case "unreachable":
      return { title: `Can't reach the backend — showing data from ${formatTime(f.dataFrom)}`, detail: "Statuses may have changed since then. Tavro keeps retrying." };
    case "stale":
      return { title: `Not updated since ${formatTime(f.dataFrom)}`, detail: "Statuses may have changed since then. Tavro keeps checking." };
  }
}
