// "Clear this account's data on this device" (spec 10.2, 12 Privacy): removes what this
// browser stores for the signed-in account and this device's preferences. The
// saved connection and sign-in are left to Change backend and Sign out, which
// already handle them.
import type { KeyValueStorage } from "@mc/api-client/demo";
import type { AlertStore } from "./alert-store.js";
import { closeSystemNotifications, saveNotificationNamesEnabled, saveSystemNotificationsEnabled } from "./system-notifications.js";
import { saveThemePreference } from "./theme.js";

export function clearLocalTavroData(storage: KeyValueStorage, alerts: AlertStore): void {
  alerts.clear();
  closeSystemNotifications();
  // The names opt-in is scoped like the alert list (backend + user).
  saveNotificationNamesEnabled(storage, alerts.key, false);
  saveSystemNotificationsEnabled(storage, false);
  saveThemePreference(storage, "system");
}
