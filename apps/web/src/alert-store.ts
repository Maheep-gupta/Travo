// Local, per-user list of Tavro Alerts for the in-app notification centre.
// Only identifiers, kinds and timestamps are stored (see @mc/domain alerts);
// names are resolved from live data when rendered.
//
// Several tabs can share one list: every change starts from the latest stored
// copy (so one tab never overwrites another's read/dismiss state), and other
// tabs' writes arrive through the `storage` event.
import type { KeyValueStorage } from "@mc/api-client/demo";
import { mergeAlerts, parseStoredAlerts, unreadCount, type StoredAlert, type TavroAlert } from "@mc/domain";

export class AlertStore {
  private alerts: readonly StoredAlert[];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string,
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
    const base = this.latest();
    const next = base.some((a) => a.id === id && !a.read) ? base.map((a) => (a.id === id ? { ...a, read: true } : a)) : base;
    this.commit(base, next);
  }

  markAllRead(): void {
    const base = this.latest();
    this.commit(base, base.some((a) => !a.read) ? base.map((a) => (a.read ? a : { ...a, read: true })) : base);
  }

  dismiss(id: string): void {
    const base = this.latest();
    this.commit(base, base.some((a) => a.id === id) ? base.filter((a) => a.id !== id) : base);
  }

  clear(): void {
    const base = this.latest();
    this.commit(base, base.length ? [] : base);
  }
}

export function alertStorageKey(backend: string, userId: string): string {
  return `tavro.alerts.v1:${backend}:${userId}`;
}
