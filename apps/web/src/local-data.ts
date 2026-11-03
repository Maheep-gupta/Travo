// "Clear this account's data on this device" (spec 10.2, 12 Privacy): removes what this
// browser stores for the signed-in account and this device's preferences. The
// saved connection and sign-in are left to Change backend and Sign out, which
// already handle them.
//
// Also the per-user boundary of local storage across sign-ins (spec 8, 18.4):
// alert history survives an expired sign-in for the same person, but not the
// arrival of a different one.
import type { KeyValueStorage } from "@mc/api-client/demo";
import { alertStorageKey, notificationBurstKey, type AlertStore } from "./alert-store.js";
import { closeSystemNotifications, saveNotificationNamesEnabled, saveSystemNotificationsEnabled } from "./system-notifications.js";
import { saveThemePreference } from "./theme.js";

export function clearLocalTavroData(storage: KeyValueStorage, alerts: AlertStore, backend: string, userId: string): void {
  alerts.clear();
  // This account's last-user record too. While still signed in it is written
  // again at the next auth event, as it describes a sign-in Clear leaves alone.
  try {
    if (storage.getItem(lastUserKey(backend)) === userId) void storage.removeItem(lastUserKey(backend));
  } catch {
    // Blocked storage: nothing was persisted.
  }
  closeSystemNotifications();
  // The names opt-in is scoped like the alert list (backend + user).
  saveNotificationNamesEnabled(storage, alerts.key, false);
  saveSystemNotificationsEnabled(storage, false);
  saveThemePreference(storage, "system");
}

/** Who last signed in to a backend on this device: the user id only, nothing else. */
export function lastUserKey(backend: string): string {
  return `tavro.lastUser.v1:${backend}`;
}

/** Removes everything stored on this device for one user of one backend. Device-wide preferences stay. */
export function forgetUserLocalData(storage: KeyValueStorage, backend: string, userId: string): void {
  const key = alertStorageKey(backend, userId);
  try {
    void storage.removeItem(key);
    void storage.removeItem(notificationBurstKey(key));
  } catch {
    // Blocked storage: there is nothing persisted to remove.
  }
  saveNotificationNamesEnabled(storage, key, false);
}

/**
 * Records that `userId` is signed in to `backend`. If someone else was the last
 * user here (their sign-in expired or was ended by auth-js without an explicit
 * Sign out), that person's alert history and names opt-in are removed first.
 * The same user signing back in keeps theirs. Returns the forgotten user's id.
 */
export function noteSignedInUser(storage: KeyValueStorage, backend: string, userId: string): string | null {
  const key = lastUserKey(backend);
  try {
    const prev = storage.getItem(key);
    // Web storage is synchronous; an async store (React Native) would be awaited by its caller.
    if (prev !== null && typeof prev !== "string") return null;
    if (prev === userId) return null;
    if (prev) forgetUserLocalData(storage, backend, prev);
    void storage.setItem(key, userId);
    return prev || null;
  } catch {
    // Blocked storage: no history is kept either, so there is nothing to forget.
    return null;
  }
}
