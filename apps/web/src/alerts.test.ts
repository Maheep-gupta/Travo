import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "@mc/api-client/demo";
import type { TavroAlert } from "@mc/domain";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import {
  loadNotificationNamesEnabled,
  loadSystemNotificationsEnabled,
  requestSystemNotifications,
  saveNotificationNamesEnabled,
  saveSystemNotificationsEnabled,
  showSystemNotification,
  systemNotificationsFailed,
  systemNotificationState,
  type NotificationApi,
} from "./system-notifications.js";
import { titleWithUnread, updateAppBadge } from "./unread-indicator.js";

const alert = (id: string, at = "2026-10-29T12:00:00Z"): TavroAlert => ({ id, kind: "failed", sessionId: "s1", hostId: "h1", at, isDemo: false });
const KEY = alertStorageKey("demo", "u1");

describe("AlertStore", () => {
  it("adds, dedupes and reports only newly added alerts", () => {
    const store = new AlertStore(new MemoryStorage(), KEY);
    expect(store.add([alert("a")]).map((a) => a.id)).toEqual(["a"]);
    expect(store.add([alert("a"), alert("b", "2026-10-29T12:01:00Z")]).map((a) => a.id)).toEqual(["b"]);
    expect(store.unread()).toBe(2);
  });

  it("persists identifiers only and restores them", () => {
    const storage = new MemoryStorage();
    const store = new AlertStore(storage, KEY);
    store.add([alert("a")]);
    store.markRead("a");
    const raw = storage.getItem(KEY) ?? "";
    expect(Object.keys(JSON.parse(raw)[0]).sort()).toEqual(["at", "hostId", "id", "isDemo", "kind", "read", "sessionId"]);
    expect(new AlertStore(storage, KEY).getSnapshot()).toEqual([{ ...alert("a"), read: true }]);
  });

  it("keeps users and backends apart", () => {
    const storage = new MemoryStorage();
    new AlertStore(storage, KEY).add([alert("a")]);
    expect(new AlertStore(storage, alertStorageKey("demo", "u2")).getSnapshot()).toEqual([]);
    expect(new AlertStore(storage, alertStorageKey("supabase", "u1")).getSnapshot()).toEqual([]);
  });

  it("supports mark all read, dismiss and clear, notifying subscribers only on change", () => {
    const store = new AlertStore(new MemoryStorage(), KEY);
    const listener = vi.fn();
    store.subscribe(listener);
    store.add([alert("a"), alert("b", "2026-10-29T12:01:00Z")]);
    store.markAllRead();
    store.markAllRead(); // no-op
    store.dismiss("a");
    store.dismiss("missing"); // no-op
    expect(store.getSnapshot().map((a) => [a.id, a.read])).toEqual([["b", true]]);
    store.clear();
    store.clear(); // no-op
    expect(store.getSnapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("does not overwrite changes made by another tab", () => {
    const storage = new MemoryStorage();
    const tabA = new AlertStore(storage, KEY);
    const tabB = new AlertStore(storage, KEY);
    tabA.add([alert("a")]);
    tabA.markAllRead();
    // Tab B still holds an empty in-memory list, but must start from what A stored.
    expect(tabB.add([alert("a"), alert("b", "2026-10-29T12:01:00Z")]).map((x) => x.id)).toEqual(["b"]);
    expect(new AlertStore(storage, KEY).getSnapshot().map((x) => [x.id, x.read])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("picks up other tabs' writes from storage events", () => {
    const storage = new MemoryStorage();
    const tabA = new AlertStore(storage, KEY);
    const tabB = new AlertStore(storage, KEY);
    let fire: ((e: StorageEvent) => void) | undefined;
    const target = { addEventListener: (_: string, l: (e: StorageEvent) => void) => (fire = l), removeEventListener: vi.fn() };
    const stop = tabB.syncAcrossTabs(target as unknown as Window);
    tabA.add([alert("a")]);
    fire?.({ key: KEY } as StorageEvent);
    expect(tabB.getSnapshot().map((x) => x.id)).toEqual(["a"]);
    stop();
    expect(target.removeEventListener).toHaveBeenCalled();
  });

  it("survives corrupt or blocked storage", () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem(KEY, "{not json");
    expect(new AlertStore(corrupt, KEY).getSnapshot()).toEqual([]);

    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    const store = new AlertStore(throwing, KEY);
    expect(store.add([alert("a")])).toHaveLength(1);
  });
});

/** A fake Notification API: permission, request behaviour and constructor are configurable. */
function fakeApi(opts: { permission: NotificationPermission; grantOnRequest?: NotificationPermission; throwOnConstruct?: boolean; callbackOnly?: boolean }) {
  const created: { title: string; options?: NotificationOptions; close: () => void; onclick: null | (() => void) }[] = [];
  const Fake = function (this: (typeof created)[number], title: string, options?: NotificationOptions) {
    if (opts.throwOnConstruct) throw new TypeError("Illegal constructor");
    this.title = title;
    this.options = options;
    this.close = vi.fn();
    this.onclick = null;
    created.push(this);
  } as unknown as NotificationApi & { permission: NotificationPermission };
  Object.assign(Fake, {
    permission: opts.permission,
    requestPermission(cb?: (p: NotificationPermission) => void) {
      (Fake as { permission: NotificationPermission }).permission = opts.grantOnRequest ?? opts.permission;
      if (opts.callbackOnly) {
        cb?.(Fake.permission);
        return undefined;
      }
      return Promise.resolve(Fake.permission);
    },
  });
  return { api: Fake, created };
}

describe("system notifications", () => {
  it("maps browser permission to states", () => {
    expect(systemNotificationState(null)).toBe("unsupported");
    expect(systemNotificationState(fakeApi({ permission: "default" }).api)).toBe("default");
    expect(systemNotificationState(fakeApi({ permission: "granted" }).api)).toBe("granted");
    expect(systemNotificationState(fakeApi({ permission: "denied" }).api)).toBe("denied");
  });

  it("requests permission with the promise and the legacy callback form", async () => {
    await expect(requestSystemNotifications(fakeApi({ permission: "default", grantOnRequest: "granted" }).api)).resolves.toBe("granted");
    await expect(requestSystemNotifications(fakeApi({ permission: "default", grantOnRequest: "denied", callbackOnly: true }).api)).resolves.toBe("denied");
    await expect(requestSystemNotifications(null)).resolves.toBe("unsupported");
  });

  it("shows generic text with a non-identifying tag, and handles clicks", () => {
    const { api, created } = fakeApi({ permission: "granted" });
    const onClick = vi.fn();
    expect(showSystemNotification(alert("a"), onClick, api)).toBe(true);
    expect(created[0]?.title).toBe("Tavro · Failed");
    expect(created[0]?.options).toMatchObject({ body: "A session reported a failure.", tag: "tavro:failed" });
    created[0]?.onclick?.();
    expect(onClick).toHaveBeenCalledOnce();
    expect(created[0]?.close).toHaveBeenCalled();
  });

  it("does nothing without permission and reports constructor failures", () => {
    expect(showSystemNotification(alert("a"), vi.fn(), fakeApi({ permission: "denied" }).api)).toBe(false);
    expect(showSystemNotification(alert("a"), vi.fn(), fakeApi({ permission: "granted", throwOnConstruct: true }).api)).toBe(false);
    expect(systemNotificationsFailed()).toBe(true);
    expect(showSystemNotification(alert("b"), vi.fn(), fakeApi({ permission: "granted" }).api)).toBe(true);
    expect(systemNotificationsFailed()).toBe(false);
  });

  it("adds names only when passed, and never puts them in the tag", () => {
    const { api, created } = fakeApi({ permission: "granted" });
    showSystemNotification(alert("a"), vi.fn(), api);
    showSystemNotification(alert("b"), vi.fn(), api, { session: "Fix auth tests", host: "Work laptop" });
    expect(created[0]?.options?.body).toBe("A session reported a failure.");
    expect(created[1]?.options?.body).toBe("Fix auth tests · Work laptop\nA session reported a failure.");
    expect(created[1]?.options?.tag).toBe("tavro:failed");
  });

  it("keeps the session-names option off by default, per user, and inert until approved", () => {
    const storage = new MemoryStorage();
    const userA = alertStorageKey("supabase", "a");
    const userB = alertStorageKey("supabase", "b");
    expect(loadNotificationNamesEnabled(storage, userA, true)).toBe(false);
    saveNotificationNamesEnabled(storage, userA, true);
    expect(loadNotificationNamesEnabled(storage, userA, true)).toBe(true);
    // Consent is personal: another user on the same browser starts with it off.
    expect(loadNotificationNamesEnabled(storage, userB, true)).toBe(false);
    // Not honoured while D-013 awaits approval, even if a value is stored.
    expect(loadNotificationNamesEnabled(storage, userA)).toBe(false);
    saveNotificationNamesEnabled(storage, userA, false);
    expect(loadNotificationNamesEnabled(storage, userA, true)).toBe(false);
  });

  it("keeps the per-device switch off by default", () => {
    const storage = new MemoryStorage();
    expect(loadSystemNotificationsEnabled(storage)).toBe(false);
    saveSystemNotificationsEnabled(storage, true);
    expect(loadSystemNotificationsEnabled(storage)).toBe(true);
    saveSystemNotificationsEnabled(storage, false);
    expect(loadSystemNotificationsEnabled(storage)).toBe(false);
  });
});

describe("unread indicator", () => {
  it("prefixes the title with the unread count", () => {
    expect(titleWithUnread(0)).toBe("Tavro");
    expect(titleWithUnread(3)).toBe("(3) Tavro");
    expect(titleWithUnread(150)).toBe("(99+) Tavro");
  });

  it("sets and clears the app badge where supported, tolerating failures", async () => {
    const api = { setAppBadge: vi.fn(() => Promise.resolve()), clearAppBadge: vi.fn(() => Promise.reject(new Error("not installed"))) };
    updateAppBadge(2, api);
    updateAppBadge(0, api);
    expect(api.setAppBadge).toHaveBeenCalledWith(2);
    expect(api.clearAppBadge).toHaveBeenCalledOnce();
    await Promise.resolve(); // the rejection is swallowed, not unhandled
    expect(() => updateAppBadge(1, {})).not.toThrow();
    expect(() => updateAppBadge(1, { setAppBadge: () => { throw new Error("sync"); }, clearAppBadge: vi.fn() })).not.toThrow();
  });
});
