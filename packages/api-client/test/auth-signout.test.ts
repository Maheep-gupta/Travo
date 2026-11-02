// Sign-out must always end the session on this device. auth-js returns an
// error and KEEPS the stored session when it could not load it first (a token
// refresh that failed on the network: GoTrueClient._signOut returns before
// _removeSession), and then emits no SIGNED_OUT. The client is faked here so
// that state can be produced without waiting out auth-js's refresh backoff.
// The fake follows auth-js 2.118: a sign-out with nothing stored sends no
// request and runs _removeSession, which emits SIGNED_OUT in this tab and
// posts it to other tabs (BroadcastChannel).
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../src/api.js";
import { MemoryStorage } from "../src/storage.js";
import { authStorageKey, createSupabaseApi } from "../src/supabase-api.js";

const URL_ = "https://example.supabase.co";
const KEY = authStorageKey(URL_);

const fake = vi.hoisted(() => ({
  /** The error a sign-out returns while a session is stored. */
  storedError: null as Error | null,
  /** Only the logout request failed: auth-js has removed the session itself. */
  removesSession: false,
  /** Every later sign-out fails too (e.g. storage broke). */
  alwaysFail: false,
  requests: 0,
  broadcasts: 0,
  stopAutoRefresh: 0,
  disposed: 0,
  authListeners: new Set<(event: string, session: { user: { id: string; email: string } } | null) => void>(),
  storage: null as { getItem(k: string): string | null; removeItem(k: string): void } | null,
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  const removeSession = (key: string) => {
    fake.storage?.removeItem(key);
    for (const cb of fake.authListeners) cb("SIGNED_OUT", null);
    fake.broadcasts += 1;
  };
  return {
    ...actual,
    createClient: (url: string) => {
      const key = `tavro.auth:${new URL(url).origin}`;
      return {
        auth: {
          signOut: () => {
            if (fake.alwaysFail) return Promise.resolve({ error: new Error("storage") });
            if (fake.storage?.getItem(key) === null) {
              removeSession(key);
              return Promise.resolve({ error: null });
            }
            fake.requests += 1;
            if (fake.removesSession || !fake.storedError) removeSession(key);
            return Promise.resolve({ error: fake.storedError });
          },
          stopAutoRefresh: () => {
            fake.stopAutoRefresh += 1;
            return Promise.resolve();
          },
          dispose: () => {
            fake.disposed += 1;
            return Promise.resolve();
          },
          onAuthStateChange: (cb: (event: string, session: { user: { id: string; email: string } } | null) => void) => {
            fake.authListeners.add(cb);
            return { data: { subscription: { unsubscribe: () => fake.authListeners.delete(cb) } } };
          },
        },
        realtime: { disconnect: () => undefined },
      };
    },
  };
});

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  storage.setItem(KEY, '{"access_token":"stale"}');
  fake.storage = storage;
  fake.storedError = null;
  fake.removesSession = false;
  fake.alwaysFail = false;
  fake.requests = 0;
  fake.broadcasts = 0;
  fake.stopAutoRefresh = 0;
  fake.disposed = 0;
  fake.authListeners.clear();
});

function makeApi() {
  const api = createSupabaseApi({ url: URL_, publishableKey: "sb_publishable_0123456789abcdef" }, storage);
  const events: (AuthUser | null)[] = [];
  const off = api.onAuthChange((u) => events.push(u));
  return { api, events, off };
}

describe("signOut when auth-js could not load the session", () => {
  for (const localOnly of [false, true]) {
    it(`removes it, has auth-js tell this and other tabs, and reports the server untold (${localOnly ? "local" : "global"} sign-out)`, async () => {
      fake.storedError = new AuthRetryableFetchError("Failed to fetch", 0);
      const { api, events } = makeApi();
      await expect(api.signOut(localOnly ? { localOnly } : undefined)).resolves.toEqual({ serverRevoked: false });
      expect(storage.getItem(KEY)).toBeNull();
      // One attempt with the session; the follow-up found nothing to send.
      expect(fake.requests).toBe(1);
      expect(fake.broadcasts).toBe(1);
      // auth-js's own SIGNED_OUT, once; auto-refresh keeps running for the next sign-in.
      expect(events).toEqual([null]);
      expect(fake.stopAutoRefresh).toBe(0);
    });
  }

  it("falls back to stopping auto-refresh and telling this tab if auth-js can't remove it either", async () => {
    fake.storedError = new AuthRetryableFetchError("Failed to fetch", 0);
    const { api, events } = makeApi();
    const signOut = api.signOut();
    fake.alwaysFail = true;
    await expect(signOut).resolves.toEqual({ serverRevoked: false });
    expect(storage.getItem(KEY)).toBeNull();
    expect(fake.stopAutoRefresh).toBe(1);
    expect(events).toEqual([null]);
  });

  it("reports a failed logout request as not revoked, though auth-js removed the session", async () => {
    fake.storedError = new AuthRetryableFetchError("Failed to fetch", 0);
    fake.removesSession = true;
    const { api, events } = makeApi();
    await expect(api.signOut()).resolves.toEqual({ serverRevoked: false });
    expect(storage.getItem(KEY)).toBeNull();
    expect(fake.stopAutoRefresh).toBe(0);
    // auth-js's own SIGNED_OUT, once.
    expect(events).toEqual([null]);
  });

  it("reports success as revoked, and an unsubscribed listener hears nothing", async () => {
    const { api, events, off } = makeApi();
    off();
    await expect(api.signOut()).resolves.toEqual({ serverRevoked: true });
    expect(fake.stopAutoRefresh).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("close (Change backend)", () => {
  it("removes the stored session without a request, tells other tabs and disposes the client", async () => {
    storage.setItem(`${KEY}-user`, "{}");
    const { api, events } = makeApi();
    await api.close();
    expect(storage.getItem(KEY)).toBeNull();
    expect(storage.getItem(`${KEY}-user`)).toBeNull();
    expect(fake.requests).toBe(0);
    expect(fake.broadcasts).toBe(1);
    expect(events).toEqual([null]);
    expect(fake.disposed).toBe(1);
  });
});
