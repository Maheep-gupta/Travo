// Wires Tavro Alerts into the app: a per-user AlertStore plus a watcher that
// runs @mc/domain's detectAlerts over the live session and host data.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { DEFAULT_NOTIFICATION_PREFS } from "@mc/contracts/constants";
import { ALERT_LABEL, HEARTBEAT_INTERVAL_MS, alertAllowed, detectAlerts, hostConnectivity, type AlertSnapshot, type StoredAlert } from "@mc/domain";
import { useApi } from "./api-context.js";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import { webStorage } from "./platform.js";
import { closeSystemNotifications, loadSystemNotificationsEnabled, showSystemNotification } from "./system-notifications.js";

const AlertStoreContext = createContext<AlertStore | null>(null);

export function AlertsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const api = useApi();
  const store = useMemo(() => new AlertStore(webStorage, alertStorageKey(api.kind, userId)), [api.kind, userId]);

  // Alert history is per person: on a shared device the next user must not see it.
  useEffect(
    () =>
      api.onAuthChange((user) => {
        if (!user) forgetAlerts(store);
      }),
    [api, store],
  );
  useEffect(() => store.syncAcrossTabs(window), [store]);

  return (
    <AlertStoreContext.Provider value={store}>
      {/* Remount (fresh baseline) whenever the backend or user changes. */}
      <AlertWatcher key={`${api.kind}:${userId}`} store={store} />
      {children}
    </AlertStoreContext.Provider>
  );
}

export function useAlertStore(): AlertStore {
  const store = useContext(AlertStoreContext);
  if (!store) throw new Error("AlertsProvider missing");
  return store;
}

export function useAlerts(): readonly StoredAlert[] {
  const store = useAlertStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Clears stored alerts and any open system notifications (sign-out, backend change). */
export function forgetAlerts(store: AlertStore): void {
  store.clear();
  closeSystemNotifications();
}

export function alertHref(alert: Pick<StoredAlert, "sessionId">): string {
  return alert.sessionId ? `/sessions/${encodeURIComponent(alert.sessionId)}` : "/hosts";
}

/**
 * Detects alerts while the app is open.
 *
 * Host connectivity is judged at the moment the host list was fetched, not
 * against the current clock: comparing old data with a new clock (sleep,
 * throttled tab, silently dropped realtime socket) would look like every host
 * disconnecting. The host list is therefore polled once per heartbeat, also in
 * background tabs, so a genuinely silent host is still noticed. Detection
 * pauses (without advancing its snapshot, so nothing is lost) while offline,
 * after a failed fetch, or while preferences are unknown.
 */
function AlertWatcher({ store }: { store: AlertStore }) {
  const api = useApi();
  const navigate = useNavigate();
  const sessions = useQuery({ queryKey: ["sessions", api.kind, "list"], queryFn: () => api.listSessions() });
  const hosts = useQuery({
    queryKey: ["hosts", api.kind],
    queryFn: () => api.listHosts(),
    refetchInterval: HEARTBEAT_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  const prefs = useQuery({ queryKey: ["prefs", api.kind], queryFn: () => api.getNotificationPrefs() });
  const snapshot = useRef<AlertSnapshot | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") closeSystemNotifications();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    if (!sessions.data || !hosts.data || sessions.error || hosts.error || prefs.isLoading || prefs.error) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const isDemo = api.kind === "demo";
    const observedAt = new Date(hosts.dataUpdatedAt);
    const result = detectAlerts(
      snapshot.current,
      sessions.data,
      hosts.data.map((h) => ({ id: h.id, connectivity: hostConnectivity(h, observedAt), last_seen_at: h.last_seen_at, is_demo: isDemo })),
    );
    snapshot.current = result.snapshot;
    // null = never saved, so the defaults genuinely apply.
    const activePrefs = prefs.data ?? DEFAULT_NOTIFICATION_PREFS;
    const added = store.add(result.alerts.filter((a) => alertAllowed(a.kind, activePrefs)));
    if (!added.length) return;

    if (document.visibilityState === "visible") {
      const first = added[0];
      if (first) setAnnouncement(added.length === 1 ? `New alert: ${ALERT_LABEL[first.kind]}` : `${added.length} new alerts`);
    } else if (loadSystemNotificationsEnabled(webStorage)) {
      for (const a of added) {
        showSystemNotification(a, () => {
          window.focus();
          store.markRead(a.id);
          void navigate(alertHref(a));
        });
      }
    }
  }, [api.kind, sessions.data, sessions.error, hosts.data, hosts.dataUpdatedAt, hosts.error, prefs.data, prefs.isLoading, prefs.error, store, navigate]);

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {announcement}
    </div>
  );
}
