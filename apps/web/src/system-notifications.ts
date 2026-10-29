// Foreground system notifications through the browser Notification API.
//
// These only work while Tavro is open in a browser tab; there is no service
// worker and no push, so nothing is delivered once the tab is closed. Permission
// is only ever requested from an explicit user action, and the per-device
// on/off switch is separate from the browser permission so users can mute
// Tavro without digging through browser settings.
import type { KeyValueStorage } from "@mc/api-client/demo";
import { alertNotificationText, type AlertNotificationNames, type TavroAlert } from "@mc/domain";

export type SystemNotificationState = "unsupported" | "default" | "granted" | "denied";

/** The parts of the Notification API we use; injectable for tests. */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  /** Old Safari implements only the callback form and returns undefined. */
  requestPermission(callback?: (p: NotificationPermission) => void): Promise<NotificationPermission> | undefined;
  new (title: string, options?: NotificationOptions): Notification;
}

/**
 * Null when the browser has no usable Notification API: insecure context, or
 * iOS/iPadOS outside an installed Home Screen app (where it is undefined).
 */
export function notificationApi(): NotificationApi | null {
  if (typeof window === "undefined" || !window.isSecureContext || !("Notification" in window)) return null;
  return window.Notification as unknown as NotificationApi;
}

export function systemNotificationState(api: NotificationApi | null = notificationApi()): SystemNotificationState {
  if (!api) return "unsupported";
  const p = api.permission;
  return p === "granted" || p === "denied" ? p : "default";
}

/**
 * Asks the browser for permission. Must be called from a click handler.
 * Supports both the promise form and the older callback form (old Safari).
 */
export async function requestSystemNotifications(api: NotificationApi | null = notificationApi()): Promise<SystemNotificationState> {
  if (!api) return "unsupported";
  try {
    await new Promise<void>((resolve) => {
      const maybe = api.requestPermission(() => resolve());
      if (maybe && typeof maybe.then === "function") maybe.then(() => resolve(), () => resolve());
    });
  } catch {
    // Some browsers throw instead of rejecting; fall through and report the state.
  }
  return systemNotificationState(api);
}

const ENABLED_KEY = "tavro.systemNotifications.v1";
/**
 * D-013 (session names in notifications) relaxes the D-009 privacy default and
 * is awaiting the product owner's approval. Until then the option is neither
 * offered nor honoured.
 */
export const SESSION_NAMES_OPTION_APPROVED = false;

/**
 * Opt-in consent is personal, so it is scoped like the alert list (backend +
 * user): another person signing in on the same browser starts with it off.
 */
function namesKey(scope: string): string {
  return `tavro.systemNotificationNames.v1:${scope}`;
}

export function loadNotificationNamesEnabled(storage: KeyValueStorage, scope: string, approved = SESSION_NAMES_OPTION_APPROVED): boolean {
  if (!approved) return false;
  try {
    return storage.getItem(namesKey(scope)) === "on";
  } catch {
    return false;
  }
}

export function saveNotificationNamesEnabled(storage: KeyValueStorage, scope: string, enabled: boolean): void {
  try {
    void (enabled ? storage.setItem(namesKey(scope), "on") : storage.removeItem(namesKey(scope)));
  } catch {
    // Blocked storage: the setting lasts for this visit only.
  }
}

export function loadSystemNotificationsEnabled(storage: KeyValueStorage): boolean {
  try {
    return storage.getItem(ENABLED_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveSystemNotificationsEnabled(storage: KeyValueStorage, enabled: boolean): void {
  try {
    void (enabled ? storage.setItem(ENABLED_KEY, "on") : storage.removeItem(ENABLED_KEY));
  } catch {
    // Blocked storage: the setting lasts for this visit only.
  }
}

// Set when the browser refused to construct a notification (Android Chrome
// always does without a service worker), so Settings can say so honestly.
let constructionFailed = false;
const open = new Set<Notification>();

export function systemNotificationsFailed(): boolean {
  return constructionFailed;
}

/**
 * Shows one notification. Returns false when the browser refused. Duplicate
 * suppression happens before this (AlertStore.add); `tag` is only an extra
 * layer because Safari ignores it. No `actions` or `renotify`: both throw or
 * are unsupported for page-created notifications.
 */
export function showSystemNotification(
  alert: TavroAlert,
  onClick: () => void,
  api: NotificationApi | null = notificationApi(),
  names?: AlertNotificationNames,
): boolean {
  if (!api || api.permission !== "granted") return false;
  try {
    const { title, body } = alertNotificationText(alert, names);
    // Non-identifying tag: OS notification history must not hold session or host ids.
    const n = new api(title, { body, tag: `tavro:${alert.kind}`, icon: "/icon-192.png" });
    open.add(n);
    n.onclose = () => open.delete(n);
    n.onclick = () => {
      onClick();
      n.close();
    };
    constructionFailed = false;
    return true;
  } catch {
    constructionFailed = true;
    return false;
  }
}

/** Closes Tavro's open notifications, e.g. once the user is back in the app. */
export function closeSystemNotifications(): void {
  for (const n of open) n.close();
  open.clear();
}
