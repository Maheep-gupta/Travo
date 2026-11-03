import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "@mc/api-client/demo";
import { planNotifications, summarizeAlerts, type TavroAlert } from "@mc/domain";
import { AlertStore, alertStorageKey, notificationBurstKey } from "./alert-store.js";
import {
  closeSystemNotifications,
  closeSystemSingles,
  loadNotificationNamesEnabled,
  loadSystemNotificationsEnabled,
  requestSystemNotifications,
  saveNotificationNamesEnabled,
  saveSystemNotificationsEnabled,
  showSystemNotification,
  showSystemSummary,
  systemNotificationsFailed,
  systemNotificationState,
  type NotificationApi,
} from "./system-notifications.js";
import { titleWithUnread, updateAppBadge } from "./unread-indicator.js";

const alert = (id: string, at = "2026-10-29T12:00:00Z"): TavroAlert => ({ id, kind: "failed", sessionId: "s1", hostId: "h1", at, isDemo: false });
const KEY = alertStorageKey("demo", "u1");

describe("AlertStore", () => {
  it("marks and dismisses several alerts in one write, ignoring unknown ids", () => {
    const storage = new MemoryStorage();
    const store = new AlertStore(storage, KEY);
    store.add([alert("a"), alert("b"), alert("c")]);
    const setItem = vi.spyOn(storage, "setItem");
    store.markManyRead(["a", "b", "gone"]);
    expect(setItem).toHaveBeenCalledOnce();
    expect(store.unread()).toBe(1);
    store.markManyRead(["a"]);
    expect(setItem).toHaveBeenCalledOnce(); // already read: nothing written
    store.dismissMany(["a", "c", "gone"]);
    expect(store.getSnapshot().map((x) => x.id)).toEqual(["b"]);
    store.dismissMany(["gone"]);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

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

  it("shows one summary for a burst, replacing open notifications, with counts and no ids or names", () => {
    const { api, created } = fakeApi({ permission: "granted" });
    showSystemNotification(alert("a"), vi.fn(), api);
    const onClick = vi.fn();
    const burst: TavroAlert[] = [alert("a"), { ...alert("b"), kind: "approval_required", sessionId: "s2" }, { ...alert("c"), kind: "completed" }];
    expect(showSystemSummary(summarizeAlerts(burst), onClick, true, api)).toBe(true);
    expect(created[0]?.close).toHaveBeenCalled();
    expect(created[1]?.title).toBe("Tavro · 3 new alerts");
    expect(created[1]?.options).toMatchObject({ body: "1 needs approval, 1 failed, 1 completed.", tag: "tavro:summary", silent: true });
    expect(JSON.stringify(created[1]?.options)).not.toMatch(/s1|s2|h1/);
    created[1]?.onclick?.();
    expect(onClick).toHaveBeenCalledOnce();
    expect(showSystemSummary(summarizeAlerts(burst), vi.fn(), false, fakeApi({ permission: "denied" }).api)).toBe(false);
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

// G32 / QA LOW-3: one burst for all of a user's tabs (counts, kinds and times only).
describe("AlertStore shared notification burst", () => {
  const T = Date.parse("2026-11-03T10:00:00Z");
  const burstOf = (n: number) => planNotifications(null, Array.from({ length: n }, (_, i) => alert(`b${i}`)), T).burst;

  it("shares one burst between two tabs' stores, scoped per user, and ends it for both", () => {
    const storage = new MemoryStorage();
    const tabA = new AlertStore(storage, KEY);
    const tabB = new AlertStore(storage, KEY);
    const other = new AlertStore(storage, alertStorageKey("demo", "u2"));
    expect(tabB.loadBurst(T)).toBeNull();
    tabA.saveBurst(burstOf(1));
    expect(tabB.loadBurst(T + 1_000)).toEqual(burstOf(1));
    expect(other.loadBurst(T + 1_000)).toBeNull();
    // Nothing identifying is stored.
    expect(storage.getItem(tabA.burstKey)).not.toMatch(/b0|s1|h1/);
    tabB.saveBurst(null);
    expect(tabA.loadBurst(T + 2_000)).toBeNull();
  });

  it("clear() removes the shared burst with the history, even when the history is already empty", () => {
    const storage = new MemoryStorage();
    const store = new AlertStore(storage, KEY);
    const other = new AlertStore(storage, alertStorageKey("demo", "u2"));
    store.saveBurst(burstOf(2));
    other.saveBurst(burstOf(1));
    expect(storage.getItem(notificationBurstKey(KEY))).not.toBeNull();
    store.clear();
    expect(storage.getItem(notificationBurstKey(KEY))).toBeNull();
    // Another user's burst is theirs.
    expect(storage.getItem(other.burstKey)).not.toBeNull();
    expect(store.burstKey).toBe(notificationBurstKey(KEY));
    // Blocked storage: clear() still works in memory.
    const blocked = new AlertStore({ getItem: () => null, setItem: () => undefined, removeItem: () => { throw new Error("blocked"); } }, KEY);
    expect(() => blocked.clear()).not.toThrow();
  });

  it("treats a malformed stored burst as none", () => {
    const storage = new MemoryStorage();
    const store = new AlertStore(storage, KEY);
    storage.setItem(store.burstKey, "{not json");
    expect(store.loadBurst(T)).toBeNull();
    storage.setItem(store.burstKey, JSON.stringify({ summary: { counts: { "Fix login": 1 }, total: 1, allDemo: false }, lastShownAt: T, lastAudibleAt: T }));
    expect(store.loadBurst(T)).toBeNull();
  });

  it("falls back to per-tab behaviour (undefined) when storage is blocked or stops accepting writes", () => {
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    const blocked = new AlertStore(throwing, KEY);
    expect(blocked.loadBurst(T)).toBeUndefined();
    expect(() => blocked.saveBurst(burstOf(1))).not.toThrow();

    // Reads work but writes fail (quota): a stored copy would go stale, so stop sharing.
    const storage = new MemoryStorage();
    const full = new AlertStore({ getItem: (k) => storage.getItem(k), setItem: () => { throw new Error("quota"); }, removeItem: (k) => storage.removeItem(k) }, KEY);
    expect(full.loadBurst(T)).toBeNull();
    full.saveBurst(burstOf(1));
    expect(full.loadBurst(T)).toBeUndefined();
  });

  it("reports other tabs' burst changes and removals, ignoring other keys and unreadable values", () => {
    const store = new AlertStore(new MemoryStorage(), KEY);
    let fire: ((e: StorageEvent) => void) | undefined;
    const target = { addEventListener: vi.fn((_: string, fn: (e: StorageEvent) => void) => (fire = fn)), removeEventListener: vi.fn() };
    const seen: unknown[] = [];
    const stop = store.watchBurst(target as unknown as Window, (b) => seen.push(b));
    const now = Date.now();
    const burst = planNotifications(null, [alert("x"), alert("y")], now).burst;
    const expired = planNotifications(null, [alert("x"), alert("y")], now - 2 * 60 * 60_000).burst;
    fire?.({ key: KEY, newValue: "[]" } as StorageEvent);
    fire?.({ key: store.burstKey, newValue: JSON.stringify(burst) } as StorageEvent);
    // Unreadable or expired: says nothing about what the user saw, so not reported as an end.
    fire?.({ key: store.burstKey, newValue: "{bad" } as StorageEvent);
    fire?.({ key: store.burstKey, newValue: JSON.stringify({ summary: { counts: { failed: 1e300 }, total: 1e300, allDemo: false }, lastShownAt: now, lastAudibleAt: now }) } as StorageEvent);
    fire?.({ key: store.burstKey, newValue: JSON.stringify(expired) } as StorageEvent);
    fire?.({ key: store.burstKey, newValue: null } as StorageEvent);
    expect(seen).toEqual([burst, null]);
    stop();
    expect(target.removeEventListener).toHaveBeenCalled();
  });

  it("closes only this tab's per-alert notifications when another tab's summary counts them", () => {
    closeSystemNotifications();
    const made: { tag: string; close: () => void }[] = [];
    const Fake = Object.assign(
      function (this: { tag: string; close: () => void }, _title: string, options?: NotificationOptions) {
        this.tag = options?.tag ?? "";
        this.close = vi.fn();
        made.push(this);
      },
      { permission: "granted" as NotificationPermission, requestPermission: () => Promise.resolve("granted" as NotificationPermission) },
    ) as unknown as NotificationApi;
    showSystemSummary(summarizeAlerts([alert("a"), alert("b")]), vi.fn(), false, Fake);
    showSystemNotification(alert("c"), vi.fn(), Fake);
    const [summary, single] = made;
    closeSystemSingles();
    expect(single?.close).toHaveBeenCalledOnce();
    // The summary's tag is shared across tabs; closing ours could close theirs.
    expect(summary?.close).not.toHaveBeenCalled();
    closeSystemNotifications();
    expect(summary?.close).toHaveBeenCalledOnce();
    expect(single?.close).toHaveBeenCalledOnce();
  });
});
