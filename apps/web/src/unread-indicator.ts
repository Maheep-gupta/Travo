// Shows the unread alert count where it is visible without opening Tavro:
// the tab title on every browser, and the app-icon badge (Badging API) where
// the browser supports it for installed apps. Both are best-effort and need
// no permission prompt from Tavro.

export const BASE_TITLE = "Tavro";

export function titleWithUnread(unread: number, base = BASE_TITLE): string {
  if (unread <= 0) return base;
  return `(${unread > 99 ? "99+" : unread}) ${base}`;
}

/** The Badging API surface; injectable for tests. */
export interface BadgeApi {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export function updateAppBadge(unread: number, api: BadgeApi | undefined = typeof navigator === "undefined" ? undefined : (navigator as BadgeApi)): void {
  if (!api?.setAppBadge || !api.clearAppBadge) return;
  try {
    // Rejects when the app is not installed or badging is not allowed; that's fine.
    void (unread > 0 ? api.setAppBadge(unread) : api.clearAppBadge()).catch(() => undefined);
  } catch {
    // Some engines throw synchronously; the badge is optional.
  }
}
