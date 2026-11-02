// Whether the data on screen is current (spec 3.5, 14.2, Part 16), and what
// the offline banner says when it isn't. Pure: a client feeds in its online
// flag and timestamps read from its query cache, so no extra requests are made
// just to find out whether we are connected. Shared by the web app and the
// future Expo app.
import { STALE_DATA_AFTER_MS } from "./freshness.js";

/**
 * A fetch that is still running gets this long before stale data is reported,
 * so resuming a frozen tab doesn't flash a warning while the refetch is on its way.
 */
export const FETCH_GRACE_MS = 15_000;

/**
 * Why the latest fetch failed, as far as the banner cares. "paused" is a
 * Supabase project answering HTTP 540; "unavailable" is a network failure,
 * timeout or 5xx (a paused project whose answer the browser can't read looks
 * like this too); "other" is anything else (rejected, not found, parse errors).
 */
export type FetchFailure = "paused" | "unavailable" | "other";

/**
 * Reads the failure kind off an error. Duck-typed on `code` so the domain
 * needn't depend on @mc/api-client: its ApiError codes "paused" and
 * "unavailable" carry over, everything else is "other".
 */
export function fetchFailureOf(error: unknown): FetchFailure {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "paused" || code === "unavailable" ? code : "other";
}

/** What the query cache says about the data the dashboard depends on. Times are epoch ms; null = never. */
export interface FetchSummary {
  /** The OLDEST latest success among those queries: the age of the stalest data on screen. */
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Why the latest failure happened; null when nothing has failed. */
  lastFailure?: FetchFailure | null;
  /** When the current run of in-flight fetches began; null when nothing is fetching. */
  fetchingSince: number | null;
}

export type ConnectionState =
  | { kind: "current" }
  /** The browser reports no network. */
  | { kind: "offline"; dataFrom: number | null }
  /**
   * Fetches are failing. `cause` "paused" is the backend saying the project is
   * paused; dataFrom is null only then, since a definite pause is reported even
   * before anything loaded. Kept under one kind so per-card freshness treats both alike.
   */
  | { kind: "unreachable"; dataFrom: number | null; cause: "paused" | "unavailable" | "error" }
  /** Nothing has failed, but nothing has refreshed the data either. */
  | { kind: "stale"; dataFrom: number };

export function connectionState(online: boolean, f: FetchSummary, now: number): ConnectionState {
  if (!online) return { kind: "offline", dataFrom: f.lastSuccessAt };
  const failedLast = f.lastFailureAt !== null && (f.lastSuccessAt === null || f.lastFailureAt > f.lastSuccessAt);
  // A pause is definite and needs the owner to act, so it is reported at once.
  if (failedLast && f.lastFailure === "paused") return { kind: "unreachable", dataFrom: f.lastSuccessAt, cause: "paused" };
  // Nothing loaded yet: pages show their own loading and error states.
  if (f.lastSuccessAt === null || now - f.lastSuccessAt <= STALE_DATA_AFTER_MS) return { kind: "current" };
  // "other" means the backend answered but refused or sent data we couldn't
  // use: don't send the user to check their connection for that.
  if (failedLast) return { kind: "unreachable", dataFrom: f.lastSuccessAt, cause: f.lastFailure === "other" ? "error" : "unavailable" };
  if (f.fetchingSince !== null && now - f.fetchingSince < FETCH_GRACE_MS) return { kind: "current" };
  return { kind: "stale", dataFrom: f.lastSuccessAt };
}

/** The subset of a TanStack Query we read; a real Query satisfies it. */
export interface QueryLike {
  readonly queryKey: readonly unknown[];
  readonly state: { readonly dataUpdatedAt: number; readonly errorUpdatedAt: number; readonly fetchStatus: string; readonly error?: unknown };
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
 * that stopped refreshing. Failures are the latest of any of them, with the
 * kind of that latest one. Paused fetches (waiting for the network) don't count as fetching.
 */
export function summarizeQueries(
  queries: Iterable<QueryLike>,
  userId: string,
): { lastSuccessAt: number | null; lastFailureAt: number | null; lastFailure: FetchFailure | null; fetching: boolean } {
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let lastFailure: FetchFailure | null = null;
  let fetching = false;
  for (const q of queries) {
    if (!isStatusQuery(q.queryKey, userId)) continue;
    const { dataUpdatedAt, errorUpdatedAt, fetchStatus } = q.state;
    // A query that never succeeded has nothing on screen; its page shows its own loading or error state.
    if (dataUpdatedAt > 0 && (lastSuccessAt === null || dataUpdatedAt < lastSuccessAt)) lastSuccessAt = dataUpdatedAt;
    if (errorUpdatedAt > 0 && (lastFailureAt === null || errorUpdatedAt > lastFailureAt)) {
      lastFailureAt = errorUpdatedAt;
      lastFailure = fetchFailureOf(q.state.error);
    }
    if (fetchStatus === "fetching") fetching = true;
  }
  return { lastSuccessAt, lastFailureAt, lastFailure, fetching };
}

/**
 * Retries per failed fetch. Status queries are also polled every heartbeat
 * (30 s), so an outage costs at most 1 + this many requests per query per poll.
 */
export const MAX_FETCH_RETRIES = 2;
/** Ceiling for the exponential back-off between those retries. */
export const RETRY_DELAY_CAP_MS = 10_000;

/**
 * Whether a failed fetch is worth retrying (TanStack's `retry`; failureCount
 * counts from 0). Only transient failures are: never an expired sign-in, a
 * refusal, a missing row or a paused project, which retrying can't fix (the
 * regular poll notices a restored project). Errors without a code, such as a
 * response that failed validation, wouldn't change on retry either.
 */
export function shouldRetryFetch(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_FETCH_RETRIES) return false;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "unavailable" || code === "unknown";
}

/** Back-off before retry n (from 0): 1 s, 2 s, 4 s ... capped at RETRY_DELAY_CAP_MS. */
export function fetchRetryDelay(failureCount: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failureCount), RETRY_DELAY_CAP_MS);
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
      if (f.cause === "paused") {
        const restore = "Restore it from the project's page in the Supabase dashboard; Tavro reconnects on its own.";
        return f.dataFrom === null
          ? { title: "Your Supabase project is paused", detail: restore }
          : { title: `Your Supabase project is paused — showing data from ${formatTime(f.dataFrom)}`, detail: `Statuses may have changed since then. ${restore}` };
      }
      if (f.cause === "error") {
        return {
          title: `Couldn't refresh your data — showing data from ${f.dataFrom === null ? "earlier" : formatTime(f.dataFrom)}`,
          detail: "Statuses may have changed since then. Your project answered, but Tavro couldn't use the response. Tavro keeps trying.",
        };
      }
      return {
        title: `Can't reach the backend — showing data from ${f.dataFrom === null ? "earlier" : formatTime(f.dataFrom)}`,
        detail: "Statuses may have changed since then. Tavro keeps retrying. If this lasts, check your connection, and whether your Supabase project was paused for inactivity.",
      };
    case "stale":
      return { title: `Not updated since ${formatTime(f.dataFrom)}`, detail: "Statuses may have changed since then. Tavro keeps checking." };
  }
}
