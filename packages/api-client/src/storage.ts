/**
 * Platform-provided key/value storage for the auth session.
 * Web: localStorage. React Native: an expo-secure-store adapter.
 * Same shape as supabase-js's `auth.storage` option.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
  /**
   * Every stored key, where the store can list them (web storage can;
   * expo-secure-store can't). Only used to find sign-ins to remove.
   */
  keys?(): readonly string[] | Promise<readonly string[]>;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Prefix of every project's stored sign-in (`authStorageKey`) and of auth-js's entries beside it. */
export const AUTH_STORAGE_PREFIX = "tavro.auth:";

/**
 * Removes `keys` and waits until an async store has done so. Never rejects:
 * a store that refuses (blocked storage) has nothing persisted to remove.
 */
export async function removeKeys(storage: KeyValueStorage, keys: readonly string[]): Promise<void> {
  await Promise.allSettled(keys.map(async (k) => storage.removeItem(k)));
}

/** auth-js's PKCE slot id: 32 hex digits (`generatePKCEFlowId`). */
const PKCE_FLOW_SLOT = /^-flow-[0-9a-f]{32}-code-verifier$/;

/**
 * Whether `key` is the session stored under `storageKey` or one of the exact
 * entries auth-js keeps beside it (@supabase/auth-js: `-user`,
 * `-code-verifier`, and the PKCE `-flows-code-verifier` index and
 * `-flow-<id>-code-verifier` slots). Not any key that merely starts with
 * `${storageKey}-`: one project's URL can extend another's, as
 * `https://p.supabase.co` and `https://p.supabase.co-x.example.com` do (L2).
 */
export function isAuthEntryOf(storageKey: string, key: string): boolean {
  if (key === storageKey) return true;
  if (!key.startsWith(storageKey)) return false;
  const suffix = key.slice(storageKey.length);
  return suffix === "-user" || suffix === "-code-verifier" || suffix === "-flows-code-verifier" || PKCE_FLOW_SLOT.test(suffix);
}

/**
 * Removes every project's stored sign-in except the one under `keep` (null:
 * all of them), with auth-js's entries beside each (`<key>-user`,
 * `<key>-code-verifier`, PKCE slots). Change backend already removes the
 * project being left, but another tab still open on it can sign back in
 * afterwards (security re-check L2), so each backend sweeps when it is
 * created. A store that can't list its keys is left as it is. Never rejects.
 */
export async function removeOtherAuthSessions(storage: KeyValueStorage, keep: string | null): Promise<void> {
  let all: readonly string[];
  try {
    all = (await storage.keys?.()) ?? [];
  } catch {
    return;
  }
  const kept = (k: string) => keep !== null && isAuthEntryOf(keep, k);
  await removeKeys(
    storage,
    all.filter((k) => k.startsWith(AUTH_STORAGE_PREFIX) && !kept(k)),
  );
}
