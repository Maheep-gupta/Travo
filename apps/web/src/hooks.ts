import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./api-context.js";
import { buildSessionViews, type SessionView } from "./view-model.js";

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
  return useQuery({ queryKey: ["hosts", api.kind], queryFn: () => api.listHosts() });
}

export function useSessionViews(): { data: SessionView[] | undefined; isLoading: boolean; error: Error | null; refetch: () => void } {
  const api = useApi();
  const now = useNow();
  const sessions = useQuery({ queryKey: ["sessions", api.kind, "list"], queryFn: () => api.listSessions() });
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
