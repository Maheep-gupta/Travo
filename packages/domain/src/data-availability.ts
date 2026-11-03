// Partial data (spec 3.5, Part 16): when one query fails and another succeeds,
// a page keeps what loaded and says exactly what is missing; only a page with
// nothing at all to show falls back to its full error state. Pure: a client
// maps each of its queries to a SourceState and renders the result. Shared by
// the web app and the future Expo app.
import { connectionIndicator, type ConnectionState } from "./connectivity.js";
import type { ClientSync } from "./freshness.js";

/** One query's state, as far as what can be shown is concerned. */
export type SourceState =
  /** First load still running: nothing to show yet. */
  | "loading"
  /** Data on screen, and the latest fetch succeeded. */
  | "ready"
  /**
   * Data on screen, but the latest refresh failed. The data stays, marked as
   * not current (syncWithRefreshes) and with the time it is from (refreshFailure).
   */
  | "refresh_failed"
  /** The first load failed: nothing to show. */
  | "failed";

/** The two facts a query library reports that matter here; TanStack's data !== undefined and isError. */
export interface QueryStateInput {
  hasData: boolean;
  /** The latest fetch failed. */
  failed: boolean;
}

export function sourceState(q: QueryStateInput): SourceState {
  if (q.hasData) return q.failed ? "refresh_failed" : "ready";
  return q.failed ? "failed" : "loading";
}

/** Whether there is data to show, current or not. */
export function hasSourceData(s: SourceState): boolean {
  return s === "ready" || s === "refresh_failed";
}

/** The queries one page is built from, by role. */
export interface PageSources {
  /** What the page is about. While it is on its first load the page shows its loading state. */
  main: SourceState;
  /**
   * Data the main data is judged by, such as the host list that decides
   * whether session statuses can be trusted. The page waits for its first
   * load, so statuses don't flash as untrusted; if it fails, the main data is
   * shown without it.
   */
  context?: SourceState;
  /** Data still worth showing on its own when the main data fails, such as a session's history. */
  fallback?: SourceState;
}

export type PageAvailability =
  | { kind: "loading" }
  /** Nothing to show: the full error state. */
  | { kind: "failed" }
  /** The main data failed; the fallback is shown, with an error scoped to what is missing. */
  | { kind: "main_missing" }
  /** The main data is shown. `contextMissing`: its context failed, so say so and don't present it as trusted. */
  | { kind: "shown"; contextMissing: boolean };

export function pageAvailability({ main, context = "ready", fallback }: PageSources): PageAvailability {
  if (main === "loading") return { kind: "loading" };
  if (main === "failed") return fallback === undefined || fallback === "failed" ? { kind: "failed" } : { kind: "main_missing" };
  if (context === "loading") return { kind: "loading" };
  return { kind: "shown", contextMissing: context === "failed" };
}

/** The lists every status on screen is built from (see isStatusQuery). */
export type StatusSource = "sessions" | "hosts";

export interface StatusSourceInput {
  source: StatusSource;
  state: SourceState;
  /** When its data on screen was fetched (epoch ms; 0 = never). */
  fetchedAt: number;
}

/** Status lists whose latest refresh failed, and the age of the oldest data they left on screen. */
export interface RefreshFailure {
  sources: StatusSource[];
  /** Epoch ms; null if none of them has a fetch time. */
  dataFrom: number | null;
}

/** Null while every status list that has data refreshed fine. */
export function refreshFailure(inputs: readonly StatusSourceInput[]): RefreshFailure | null {
  const failed = inputs.filter((i) => i.state === "refresh_failed");
  if (failed.length === 0) return null;
  const times = failed.map((i) => i.fetchedAt).filter((t) => t > 0);
  return { sources: failed.map((i) => i.source), dataFrom: times.length ? Math.min(...times) : null };
}

/**
 * The client sync to judge statuses by. A status list whose refresh just
 * failed is no longer current, even before the offline banner's 90 s
 * threshold: its cards turn stale ("Not refreshed recently") and host
 * connectivity is judged as of its last fetch. Anything the banner already
 * reports wins.
 */
export function syncWithRefreshes(sync: ClientSync, states: readonly SourceState[]): ClientSync {
  return sync === "current" && states.includes("refresh_failed") ? "stale" : sync;
}

/** What the top bar shows: tone, visible text, and the accessible label. */
export type ConnectionIndicator = ReturnType<typeof connectionIndicator>;

/**
 * The top bar's backend indicator, by the same rule as the pages: the banner's
 * state (connectionIndicator), except that while the banner sees nothing wrong
 * a status list whose refresh failed, or that never loaded, keeps it from
 * saying "Connected". A page saying "Couldn't refresh host status" or
 * "Statuses can't be confirmed" must never sit under a green pill.
 */
export function statusIndicator(connection: ConnectionState, states: readonly SourceState[]): ConnectionIndicator {
  if (connection.kind !== "current") return connectionIndicator(connection);
  if (states.includes("failed")) return { tone: "warn", text: "Incomplete", label: "Some of your data couldn't be loaded, so statuses can't be confirmed" };
  if (states.includes("refresh_failed")) return { tone: "warn", text: "Not refreshing", label: "Some of your data couldn't be refreshed, so statuses may be out of date" };
  return connectionIndicator(connection);
}
