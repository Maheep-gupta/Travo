import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SignOutResult, TavroApi } from "@mc/api-client/demo";
import { buildSessionViews, type SessionView } from "@mc/domain";
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

export function useHosts() {
  const api = useApi();
  const userId = useUserId();
  return useQuery({ queryKey: userKey(api, userId, "hosts"), queryFn: () => api.listHosts() });
}

export function useSessionViews(): { data: SessionView[] | undefined; isLoading: boolean; error: Error | null; refetch: () => void } {
  const api = useApi();
  const userId = useUserId();
  // The banner's clock, so cards turn stale when it appears.
  const now = useNow(5_000);
  const sessions = useQuery({ queryKey: userKey(api, userId, "sessions", "list"), queryFn: () => api.listSessions() });
  const hosts = useHosts();
  const sync = useConnection(now).kind;
  const data = useMemo(
    () =>
      sessions.data && hosts.data
        ? buildSessionViews(sessions.data, hosts.data, now, { sync, sessionsFetchedAt: sessions.dataUpdatedAt, hostsFetchedAt: hosts.dataUpdatedAt })
        : undefined,
    [sessions.data, sessions.dataUpdatedAt, hosts.data, hosts.dataUpdatedAt, sync, now],
  );
  return {
    data,
    isLoading: sessions.isLoading || hosts.isLoading,
    error: sessions.error ?? hosts.error,
    refetch: () => {
      void sessions.refetch();
      void hosts.refetch();
    },
  };
}
