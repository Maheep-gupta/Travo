// Wires Tavro Alerts into the app: a per-user AlertStore plus a watcher that
// runs @mc/domain's detectAlerts over the live session and host data.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { DEFAULT_NOTIFICATION_PREFS } from "@mc/contracts/constants";
import {
  ALERT_LABEL,
  HEARTBEAT_INTERVAL_MS,
  alertAllowed,
  detectAlerts,
  hostConnectivity,
  notificationName,
  planNotifications,
  type AlertSnapshot,
  type NotificationBurst,
  type StoredAlert,
} from "@mc/domain";
import { useApi } from "./api-context.js";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import { UserIdContext, userKey } from "./hooks.js";
import { webStorage } from "./platform.js";
import { closeSystemNotifications, closeSystemSingles, loadNotificationNamesEnabled, loadSystemNotificationsEnabled, showSystemNotification, showSystemSummary } from "./system-notifications.js";

const AlertStoreContext = createContext<AlertStore | null>(null);

export function AlertsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const api = useApi();
  const store = useMemo(() => new AlertStore(webStorage, alertStorageKey(api.kind, userId)), [api.kind, userId]);

  // Alert history is per person: on a shared device the next user must not see
  // it. A switch straight to another account counts as this user leaving. A
  // sign-in that merely ended (expiry, failed refresh, another tab) keeps the
  // history for when the same person returns: auth-js can't tell those apart
  // from Sign out, which clears it itself, and a different user's arrival
  // removes it (noteSignedInUser). Open system notifications close either way.
  useEffect(
    () =>
      api.onAuthChange((user) => {
        if (!user) closeSystemNotifications();
        else if (user.id !== userId) forgetAlerts(store);
      }),
    [api, store, userId],
  );
  useEffect(() => store.syncAcrossTabs(window), [store]);

  return (
    <UserIdContext value={userId}>
      <AlertStoreContext.Provider value={store}>
        {/* Remount (fresh baseline) whenever the backend or user changes. */}
        <AlertWatcher key={`${api.kind}:${userId}`} store={store} userId={userId} />
        {children}
      </AlertStoreContext.Provider>
    </UserIdContext>
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

/** Clears stored alerts and any open system notifications (Sign out, backend change, another user). */
export function forgetAlerts(store: AlertStore): void {
  store.clear();
  closeSystemNotifications();
}

export function alertHref(alert: Pick<StoredAlert, "sessionId">): string {
  return alert.sessionId ? `/sessions/${encodeURIComponent(alert.sessionId)}` : "/hosts";
}

/** Whether every row belongs to `userId` (rows carry their owner, set by the database). */
function ownedBy(rows: readonly { owner_id: string }[], userId: string): boolean {
  return rows.every((r) => r.owner_id === userId);
}

/**
 * Detects alerts while the app is open.
 *
 * Host connectivity is judged at the moment the host list was fetched, not
 * against the current clock: comparing old data with a new clock (sleep,
 * throttled tab, silently dropped realtime socket) would look like every host
 * disconnecting. The host list is therefore polled once per heartbeat, also in
 * background tabs, so a genuinely silent host is still noticed. The session
 * list is polled the same way, so a silently dropped realtime channel can't
 * freeze it (pages share both queries; nothing is fetched twice). Detection
 * pauses (without advancing its snapshot, so nothing is lost) while offline,
 * after a failed fetch, while preferences are unknown, or while the data
 * belongs to another account.
 */
function AlertWatcher({ store, userId }: { store: AlertStore; userId: string }) {
  const api = useApi();
  const navigate = useNavigate();
  // Same keys as the pages (user id included), so the baseline only ever sees
  // this user's data. Every observer of these keys pins its reads to the user
  // (asUser): a sign-in in another tab can swap the stored token before this
  // tab hears of it, and that account's answer, even an empty list or "no
  // preferences saved", would otherwise be cached here as this user's (L3).
  const sessions = useQuery({
    queryKey: userKey(api, userId, "sessions", "list"),
    queryFn: () => api.listSessions({ asUser: userId }),
    refetchInterval: HEARTBEAT_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  const hosts = useQuery({
    queryKey: userKey(api, userId, "hosts"),
    queryFn: () => api.listHosts({ asUser: userId }),
    refetchInterval: HEARTBEAT_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  const prefs = useQuery({ queryKey: userKey(api, userId, "prefs"), queryFn: () => api.getNotificationPrefs({ asUser: userId }) });
  const snapshot = useRef<AlertSnapshot | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Alerts notified recently, so a burst becomes one summary (spec 16: no
  // notification storms). The user's tabs share it through storage, so two
  // hidden tabs make one sound per storm; this copy is the fallback when
  // storage can't be used.
  const burst = useRef<NotificationBurst | null>(null);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      closeSystemNotifications();
      // The user has seen the app; the next alert is news again, in every tab.
      burst.current = null;
      store.saveBurst(null);
    };
    document.addEventListener("visibilitychange", onVisible);
    // Opening or reloading Tavro in view is looking at it too; no visibilitychange comes for that.
    onVisible();
    // Another tab's change: the user looked there (ended), or its summary now counts this tab's singles.
    const unwatch = store.watchBurst(window, (shared) => {
      if (shared === null) closeSystemNotifications();
      else if (shared.summary.total > 1) closeSystemSingles();
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unwatch();
    };
  }, [store]);

  useEffect(() => {
    if (!sessions.data || !hosts.data || sessions.error || hosts.error || prefs.isLoading || prefs.error) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    // Defence in depth behind the pinned reads: rows of another account are
    // never baselined or stored under this user.
    if (!ownedBy(sessions.data, userId) || !ownedBy(hosts.data, userId)) return;
    const isDemo = api.kind === "demo";
    const observedAt = new Date(hosts.dataUpdatedAt);
    const result = detectAlerts(
      snapshot.current,
      sessions.data,
      hosts.data.map((h) => ({ id: h.id, connectivity: hostConnectivity(h, observedAt), last_seen_at: h.last_seen_at, provider_error_since: h.provider_error_since, is_demo: isDemo })),
      // Lets detection notice this tab's own gaps (sleep, frozen tab), so a host that slept with it isn't alerted.
      observedAt,
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
      const now = Date.now();
      const shared = store.loadBurst(now);
      const { plan, burst: next } = planNotifications(shared === undefined ? burst.current : shared, added, now);
      let shown = false;
      if (plan?.kind === "summary") {
        // The list is where a burst makes sense; opening it marks nothing read.
        shown = showSystemSummary(
          plan.summary,
          () => {
            window.focus();
            void navigate("/alerts");
          },
          plan.silent,
        );
      } else if (plan?.kind === "single") {
        const a = plan.alert;
        // Names only if the user opted in on this device (D-013); generic otherwise.
        const withNames = loadNotificationNamesEnabled(webStorage, store.key);
        const s = a.sessionId ? sessions.data.find((x) => x.id === a.sessionId) : undefined;
        const names = withNames ? { session: s ? notificationName(s.title) ?? s.project_label : null, host: hosts.data.find((h) => h.id === a.hostId)?.name ?? null } : undefined;
        shown = showSystemNotification(
          a,
          () => {
            window.focus();
            store.markRead(a.id);
            void navigate(alertHref(a));
          },
          undefined,
          names,
        );
      }
      // Only what was actually shown joins the burst. Other tabs react to the
      // shared copy by closing their own notifications, so recording one the
      // browser refused would remove theirs with nothing in its place.
      if (shown) {
        burst.current = next;
        store.saveBurst(next);
      }
    }
  }, [api.kind, userId, sessions.data, sessions.error, hosts.data, hosts.dataUpdatedAt, hosts.error, prefs.data, prefs.isLoading, prefs.error, store, navigate]);

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {announcement}
    </div>
  );
}
