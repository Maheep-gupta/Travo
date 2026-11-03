import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveUpdatesStatus, SignOutResult, TavroApi } from "@mc/api-client/demo";
import {
  buildSessionViews,
  refreshFailure,
  sourceState,
  syncWithRefreshes,
  type ClientSync,
  type RefreshFailure,
  type SessionView,
  type SourceState,
} from "@mc/domain";
import { useApi } from "./api-context.js";
import { connectionState, fetchRetryDelay, shouldRetryFetch, summarizeQueries, type ConnectionState, type FetchSummary } from "./connectivity.js";

/** The signed-in user's id. Provided by AlertsProvider, the per-user boundary of the app. */
export const UserIdContext = createContext<string | null>(null);

export function useUserId(): string {
  const userId = useContext(UserIdContext);
  if (!userId) throw new Error("No signed-in user");
  return userId;
}

/**
 * Tells the auth gate how an explicit sign-out ended. The control that started
 * it unmounts with the signed-in app, so the sign-in page reports the outcome.
 */
export const SignOutReportContext = createContext<(result: SignOutResult) => void>(() => undefined);

/** Cached data that belongs to one user. Only the schema version is shared. */
export type UserDataScope = "sessions" | "hosts" | "prefs";

/**
 * Query key for user-owned data: [scope, backend, userId, ...rest]. The user
 * id means one account's cache can never answer another account's query; the
 * scope stays first so prefix invalidation such as ["hosts"] still matches.
 */
export function userKey(api: Pick<TavroApi, "kind">, userId: string, scope: UserDataScope, ...rest: readonly string[]): readonly string[] {
  return [scope, api.kind, userId, ...rest];
}

/** Drops every cached query except the (user-independent) schema version. */
export function clearUserData(queryClient: QueryClient): void {
  const isUserData = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== "schema";
  void queryClient.cancelQueries({ predicate: isUserData });
  queryClient.removeQueries({ predicate: isUserData });
}

/**
 * The app's query client. Retries are TanStack's alone (supabase-js retries
 * are off): transient failures only, at most MAX_FETCH_RETRIES with capped
 * exponential back-off, so an outage doesn't multiply the 30 s polls. Never an
 * expired sign-in, which retrying can't fix and would only delay the return to
 * the sign-in page, nor a paused project, which the next poll picks up once restored.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, retry: shouldRetryFetch, retryDelay: fetchRetryDelay, refetchOnWindowFocus: true },
    },
  });
}

/** Current time, refreshed periodically so relative times and connectivity stay correct. */
export function useNow(intervalMs = 10_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * How often the status clock ticks. The offline banner, the top bar's
 * indicator and the session views read the same clock (useStatusClock), so
 * crossing the stale threshold changes all three in the same render.
 */
export const STATUS_CLOCK_MS = 5_000;

const statusClock = {
  now: new Date(),
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null,
};

/** The clock's time. While nothing is subscribed it doesn't tick, so a first reader gets the real time, not an old tick. */
function readStatusClock(): Date {
  if (statusClock.timer === null && Math.abs(Date.now() - statusClock.now.getTime()) >= STATUS_CLOCK_MS) statusClock.now = new Date();
  return statusClock.now;
}

function subscribeStatusClock(onChange: () => void): () => void {
  if (statusClock.timer === null) {
    readStatusClock();
    statusClock.timer = setInterval(() => {
      statusClock.now = new Date();
      for (const l of statusClock.listeners) l();
    }, STATUS_CLOCK_MS);
  }
  statusClock.listeners.add(onChange);
  return () => {
    statusClock.listeners.delete(onChange);
    if (statusClock.listeners.size === 0 && statusClock.timer !== null) {
      clearInterval(statusClock.timer);
      statusClock.timer = null;
    }
  };
}

/**
 * The one shared status clock: a single interval, however many components
 * read it. Each tick is an ordinary (batched) state update, like useNow's;
 * useSyncExternalStore would force a synchronous re-render per tick, which
 * a long fake-timer advance (or a resumed tab) turns into nested updates.
 */
export function useStatusClock(): Date {
  const [now, setNow] = useState(readStatusClock);
  useEffect(() => subscribeStatusClock(() => setNow(statusClock.now)), []);
  return now;
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Browsers only ever report a definite "no network"; anything else counts as online. */
function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}

/** Keeps `prev` (no re-render) when nothing changed; remembers when the current run of fetches began. */
function toSummary(s: ReturnType<typeof summarizeQueries>, prev: FetchSummary | null): FetchSummary {
  const fetchingSince = s.fetching ? (prev?.fetchingSince ?? Date.now()) : null;
  if (
    prev &&
    prev.lastSuccessAt === s.lastSuccessAt &&
    prev.lastFailureAt === s.lastFailureAt &&
    prev.lastFailure === s.lastFailure &&
    prev.fetchingSince === fetchingSince
  ) {
    return prev;
  }
  return { lastSuccessAt: s.lastSuccessAt, lastFailureAt: s.lastFailureAt, lastFailure: s.lastFailure, fetchingSince };
}

/** The signed-in user's fetch history, kept in step with the query cache. */
function useFetchSummary(userId: string): FetchSummary {
  const cache = useQueryClient().getQueryCache();
  const [summary, setSummary] = useState<FetchSummary>(() => toSummary(summarizeQueries(cache.getAll(), userId), null));
  useEffect(() => {
    const update = () => setSummary((prev) => toSummary(summarizeQueries(cache.getAll(), userId), prev));
    update();
    return cache.subscribe(update);
  }, [cache, userId]);
  return summary;
}

/**
 * Whether the data on screen is current (spec 3.5, 14.2), from the browser's
 * online flag and the query cache; it never fetches anything itself. The
 * offline banner and every freshness note read this, so they always agree.
 */
export function useConnection(now: Date): ConnectionState {
  const online = useBrowserOnline();
  const summary = useFetchSummary(useUserId());
  return connectionState(online, summary, now.getTime());
}

const noLiveUpdates = () => () => undefined;

/** The live-updates channel's state (Settings); null where the backend has none or nothing is subscribed. */
export function useLiveUpdatesStatus(): LiveUpdatesStatus | null {
  const live = useApi().liveUpdates;
  return useSyncExternalStore(live ? live.onChange : noLiveUpdates, () => live?.status() ?? null);
}

export function useHosts() {
  const api = useApi();
  const userId = useUserId();
  return useQuery({ queryKey: userKey(api, userId, "hosts"), queryFn: () => api.listHosts() });
}

function useSessionList() {
  const api = useApi();
  const userId = useUserId();
  return useQuery({ queryKey: userKey(api, userId, "sessions", "list"), queryFn: () => api.listSessions() });
}

export interface StatusSync {
  /** The banner's state: this client's own fetches. */
  connection: ConnectionState;
  /** The status lists on their own (spec 3.5 partial data). */
  sessions: SourceState;
  hosts: SourceState;
  /** The banner's state, made stale by a failed refresh; what statuses are judged by. */
  sync: ClientSync;
}

/**
 * The one rule for "can the statuses on screen be trusted right now", shared
 * by the top bar's indicator and every page (through useSessionViews), so the
 * pill never says Connected while a page says it couldn't refresh.
 */
export function useStatusSync(): StatusSync {
  return statusSyncOf(useConnection(useStatusClock()), useSessionList(), useHosts());
}

/** The query facts statusSyncOf reads; TanStack's results satisfy it. */
interface ListQuery {
  data: unknown;
  isError: boolean;
}

function statusSyncOf(connection: ConnectionState, sessions: ListQuery, hosts: ListQuery): StatusSync {
  const sessionsState = sourceState({ hasData: sessions.data !== undefined, failed: sessions.isError });
  const hostsState = sourceState({ hasData: hosts.data !== undefined, failed: hosts.isError });
  return { connection, sessions: sessionsState, hosts: hostsState, sync: syncWithRefreshes(connection.kind, [sessionsState, hostsState]) };
}

export interface SessionViewsResult {
  /** Built once the session list is in and the host list has loaded or failed; see buildSessionViews for the latter. */
  data: SessionView[] | undefined;
  /** Each list on its own, for pageAvailability (spec 3.5 partial data). */
  sessions: SourceState;
  hosts: SourceState;
  sessionsError: Error | null;
  hostsError: Error | null;
  /** Lists whose latest refresh failed (their data stays on screen); null when none. */
  refresh: RefreshFailure | null;
  /** The banner's state, made stale by a failed refresh; what the views were judged by. */
  sync: ClientSync;
  /** Either list is on its first load. */
  isLoading: boolean;
  /** The first of the two lists' latest errors; pages pick the one that matches what is missing. */
  error: Error | null;
  refetch: () => void;
  refetchSessions: () => void;
  refetchHosts: () => void;
}

export function useSessionViews(): SessionViewsResult {
  // The banner's clock, so cards turn stale when it appears.
  const now = useStatusClock();
  const sessions = useSessionList();
  const hosts = useHosts();
  const { sessions: sessionsState, hosts: hostsState, sync } = statusSyncOf(useConnection(now), sessions, hosts);
  const refresh = refreshFailure([
    { source: "sessions", state: sessionsState, fetchedAt: sessions.dataUpdatedAt },
    { source: "hosts", state: hostsState, fetchedAt: hosts.dataUpdatedAt },
  ]);
  // A failed host list (never loaded) still lets sessions show, as untrusted; a loading one doesn't, so nothing flashes.
  const hostsSettled = hosts.data !== undefined || hostsState === "failed";
  const data = useMemo(
    () =>
      sessions.data && hostsSettled
        ? buildSessionViews(sessions.data, hosts.data ?? null, now, { sync, sessionsFetchedAt: sessions.dataUpdatedAt, hostsFetchedAt: hosts.dataUpdatedAt })
        : undefined,
    [sessions.data, sessions.dataUpdatedAt, hosts.data, hosts.dataUpdatedAt, hostsSettled, sync, now],
  );
  const refetchSessions = () => void sessions.refetch();
  const refetchHosts = () => void hosts.refetch();
  return {
    data,
    sessions: sessionsState,
    hosts: hostsState,
    sessionsError: sessions.error,
    hostsError: hosts.error,
    refresh,
    sync,
    isLoading: sessions.isLoading || hosts.isLoading,
    error: sessions.error ?? hosts.error,
    refetch: () => {
      refetchSessions();
      refetchHosts();
    },
    refetchSessions,
    refetchHosts,
  };
}
