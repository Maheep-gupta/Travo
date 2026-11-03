// Local, per-user list of Tavro Alerts for the in-app notification centre.
// Only identifiers, kinds and timestamps are stored (see @mc/domain alerts);
// names are resolved from live data when rendered.
//
// Several tabs can share one list: every change starts from the latest stored
// copy (so one tab never overwrites another's read/dismiss state), and other
// tabs' writes arrive through the `storage` event.
import type { KeyValueStorage } from "@mc/api-client/demo";
import { mergeAlerts, parseNotificationBurst, parseStoredAlerts, unreadCount, type NotificationBurst, type StoredAlert, type TavroAlert } from "@mc/domain";

export class AlertStore {
  private alerts: readonly StoredAlert[];
  private readonly listeners = new Set<() => void>();
  /** False once storage failed for the shared burst: each tab then keeps its own. */
  private burstShared = true;

  constructor(
    private readonly storage: KeyValueStorage,
    /** Storage key; also scopes per-user settings such as notification names. */
    readonly key: string,
  ) {
    this.alerts = this.read() ?? [];
  }

  /** The stored list, or null when storage is unavailable (then memory is the source of truth). */
  private read(): StoredAlert[] | null {
    try {
      const raw = this.storage.getItem(this.key);
      // Web storage is synchronous; an async store (React Native) would hydrate separately.
      if (raw === null) return [];
      return typeof raw === "string" ? parseStoredAlerts(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private latest(): readonly StoredAlert[] {
    return this.read() ?? this.alerts;
  }

  private publish(next: readonly StoredAlert[]): void {
    this.alerts = next;
    for (const l of this.listeners) l();
  }

  private commit(base: readonly StoredAlert[], next: readonly StoredAlert[]): void {
    if (next === base) {
      // Nothing to write; just catch up if another tab changed the list.
      if (base !== this.alerts && JSON.stringify(base) !== JSON.stringify(this.alerts)) this.publish(base);
      return;
    }
    try {
      void this.storage.setItem(this.key, JSON.stringify(next));
    } catch {
      // Quota or blocked storage: keep working in memory for this visit.
    }
    this.publish(next);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly StoredAlert[] => this.alerts;

  /** Picks up writes from other tabs. Returns an unsubscribe function. */
  syncAcrossTabs(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
    const onStorage = (e: StorageEvent) => {
      if (e.key === this.key || e.key === null) this.publish(this.read() ?? this.alerts);
    };
    target.addEventListener("storage", onStorage);
    return () => target.removeEventListener("storage", onStorage);
  }

  unread(): number {
    return unreadCount(this.alerts);
  }

  /** Adds alerts, ignoring ones already stored (by any tab). Returns only the newly added ones. */
  add(incoming: readonly TavroAlert[]): StoredAlert[] {
    const base = this.latest();
    const next = mergeAlerts(base, incoming);
    this.commit(base, next);
    const before = new Set(base.map((a) => a.id));
    return next.filter((a) => !before.has(a.id));
  }

  markRead(id: string): void {
    this.markManyRead([id]);
  }

  /** Marks several alerts read in one write, e.g. a grouped burst. */
  markManyRead(ids: readonly string[]): void {
    const set = new Set(ids);
    const base = this.latest();
    const next = base.some((a) => set.has(a.id) && !a.read) ? base.map((a) => (set.has(a.id) && !a.read ? { ...a, read: true } : a)) : base;
    this.commit(base, next);
  }

  markAllRead(): void {
    const base = this.latest();
    this.commit(base, base.some((a) => !a.read) ? base.map((a) => (a.read ? a : { ...a, read: true })) : base);
  }

  dismiss(id: string): void {
    this.dismissMany([id]);
  }

  /** Removes several alerts in one write. Ids no longer stored are ignored. */
  dismissMany(ids: readonly string[]): void {
    const set = new Set(ids);
    const base = this.latest();
    this.commit(base, base.some((a) => set.has(a.id)) ? base.filter((a) => !set.has(a.id)) : base);
  }

  /** Removes the alert history and the shared notification burst (Sign out, Clear, another user). */
  clear(): void {
    const base = this.latest();
    this.commit(base, base.length ? [] : base);
    try {
      void this.storage.removeItem(this.burstKey);
    } catch {
      // Blocked storage: no burst was persisted.
    }
  }

  /** Storage key of the notification burst this user's tabs share (counts, kinds and times only). */
  get burstKey(): string {
    return notificationBurstKey(this.key);
  }

  /**
   * The notification burst shared by this user's tabs (spec 16: one storm
   * makes one sound, however many tabs are open). Null when there is none or
   * it expired; undefined when storage can't be used, so the caller falls
   * back to the burst it keeps itself.
   */
  loadBurst(now: number): NotificationBurst | null | undefined {
    if (!this.burstShared) return undefined;
    let raw: ReturnType<KeyValueStorage["getItem"]>;
    try {
      raw = this.storage.getItem(this.burstKey);
    } catch {
      // Blocked storage: each tab keeps its own from now on.
      this.burstShared = false;
      return undefined;
    }
    if (raw === null) return null;
    // Web storage is synchronous; an async store (React Native) keeps per-tab behaviour.
    if (typeof raw !== "string") return undefined;
    try {
      return parseNotificationBurst(JSON.parse(raw), now);
    } catch {
      return null; // Malformed: no burst.
    }
  }

  /** Shares the burst with this user's other tabs; null ends it (the user looked at Tavro). */
  saveBurst(burst: NotificationBurst | null): void {
    if (!this.burstShared) return;
    try {
      void (burst ? this.storage.setItem(this.burstKey, JSON.stringify(burst)) : this.storage.removeItem(this.burstKey));
    } catch {
      // Quota or blocked storage: the stored copy would go stale, so each tab keeps its own from now on.
      this.burstShared = false;
    }
  }

  /**
   * Reports other tabs' changes to the shared burst; null means another tab
   * ended it. An unreadable or expired value is ignored: it says nothing about
   * what the user has seen, so it must not close this tab's notifications.
   * Returns an unsubscribe function.
   */
  watchBurst(target: Pick<Window, "addEventListener" | "removeEventListener">, listener: (burst: NotificationBurst | null) => void): () => void {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== this.burstKey) return;
      if (e.newValue === null) {
        listener(null);
        return;
      }
      let burst: NotificationBurst | null = null;
      try {
        burst = parseNotificationBurst(JSON.parse(e.newValue), Date.now());
      } catch {
        // Malformed: ignored below.
      }
      if (burst) listener(burst);
    };
    target.addEventListener("storage", onStorage);
    return () => target.removeEventListener("storage", onStorage);
  }
}

export function alertStorageKey(backend: string, userId: string): string {
  return `tavro.alerts.v1:${backend}:${userId}`;
}

/** Storage key of the notification burst shared by the tabs of the user whose alert list is `alertKey`. */
export function notificationBurstKey(alertKey: string): string {
  return `tavro.notificationBurst.v1:${alertKey}`;
}
