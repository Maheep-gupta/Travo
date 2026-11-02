import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { TavroApi } from "@mc/api-client/demo";
import { useApi } from "./api-context.js";
import { buildSessionViews, type SessionView } from "./view-model.js";

/** The signed-in user's id. Provided by AlertsProvider, the per-user boundary of the app. */
export const UserIdContext = createContext<string | null>(null);

export function useUserId(): string {
  const userId = useContext(UserIdContext);
  if (!userId) throw new Error("No signed-in user");
  return userId;
}

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

/** Current time, refreshed periodically so relative times and connectivity stay correct. */
export function useNow(intervalMs = 10_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useHosts() {
  const api = useApi();
  const userId = useUserId();
  return useQuery({ queryKey: userKey(api, userId, "hosts"), queryFn: () => api.listHosts() });
}

export function useSessionViews(): { data: SessionView[] | undefined; isLoading: boolean; error: Error | null; refetch: () => void } {
  const api = useApi();
  const userId = useUserId();
  const now = useNow();
  const sessions = useQuery({ queryKey: userKey(api, userId, "sessions", "list"), queryFn: () => api.listSessions() });
  const hosts = useHosts();
  const data = useMemo(
    () => (sessions.data && hosts.data ? buildSessionViews(sessions.data, hosts.data, now) : undefined),
    [sessions.data, hosts.data, now],
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
