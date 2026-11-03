// Authentication lifecycle through the real App shell: switching accounts
// without signing out (G2), expired authentication (G3), signing in again
// after signing out, races between a slow getUser or a slow query and an auth
// event, other tabs, alert history across sign-ins (M2) and a rejected
// publishable key (L1). Only backend creation is swapped for a fake.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AuthUser, type BackendKind, type ChangeTopic, type SignOutResult, type TavroApi } from "@mc/api-client/demo";
import type { HostRow, NotificationPrefs, PairingTicket, SessionEventRow, SessionMessageRow, SessionRow, SessionStatus } from "@mc/contracts";
import { MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import { ApiProvider, CLOSE_WAIT_MS } from "./api-context.js";
import { App, SERVER_NOT_TOLD_MESSAGE } from "./App.js";
import { lastUserKey } from "./local-data.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));
const notifications = vi.hoisted(() => ({ closed: 0 }));

// Counts closes of open system notifications; the real function still runs.
vi.mock("./system-notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./system-notifications.js")>();
  return {
    ...actual,
    closeSystemNotifications: () => {
      notifications.closed += 1;
      actual.closeSystemNotifications();
    },
  };
});

// ApiProvider builds its backend through platform.createApi; hand it the fake.
vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

const A: AuthUser = { id: "00000000-0000-4000-8000-00000000000a", email: "a@example.test" };
const B: AuthUser = { id: "00000000-0000-4000-8000-00000000000b", email: "b@example.test" };
const A_TITLE = "Alpha private refactor";
const B_TITLE = "Bravo release prep";
const T0 = "2026-10-29T10:00:00.000Z";
const EXPIRED_NOTICE = "Your session expired. Sign in again.";

function hostId(owner: AuthUser): string {
  return owner === A ? "00000000-0000-4000-8000-0000000000a1" : "00000000-0000-4000-8000-0000000000b1";
}

function sessionRow(owner: AuthUser, id: string, title: string, status: SessionStatus): SessionRow {
  return {
    id,
    owner_id: owner.id,
    host_id: hostId(owner),
    provider: "mock",
    external_id: id,
    title,
    project_label: null,
    status,
    status_reason: null,
    status_source: "mock",
    last_activity_at: T0,
    last_event_summary: null,
    capabilities: ["discover"],
    is_demo: true,
    started_at: T0,
    ended_at: null,
    updated_at: T0,
  };
}

/**
 * Backend that answers as the user its token belongs to, like RLS does.
 * B already has a session needing approval: if B's first load were compared
 * against A's data it would look new and raise an alert.
 */
class FakeApi implements TavroApi {
  user: AuthUser | null = A;
  failWith: Error | null = null;
  schemaError: Error | null = null;
  /** When set, getUser answers only once this settles (a slow stored-session read). */
  slowGetUser: Promise<AuthUser | null> | null = null;
  getUserCalls = 0;
  /** When set, A's session list is answered only once this settles (a slow request in flight). */
  holdA: Promise<void> | null = null;
  readonly prefsCalls = new Map<string, number>();
  readonly signOutCalls: ({ localOnly?: boolean } | undefined)[] = [];
  /** What signOut reports: false when the server couldn't be told. */
  serverRevoked = true;
  closeCalls = 0;
  private readonly data = new Map<string, SessionRow[]>([
    [A.id, [sessionRow(A, "00000000-0000-4000-8000-0000000001a1", A_TITLE, "running")]],
    [B.id, [sessionRow(B, "00000000-0000-4000-8000-0000000001b1", B_TITLE, "approval_required")]],
  ]);
  private readonly authListeners = new Set<(user: AuthUser | null) => void>();

  constructor(readonly kind: BackendKind) {}

  private owner(): AuthUser {
    if (!this.user) throw new ApiError("Please sign in.", "unauthorized");
    if (this.failWith) throw this.failWith;
    return this.user;
  }
  /** Token swap / sign-in in another tab: the next auth event is a different user. */
  switchTo(user: AuthUser | null): void {
    this.user = user;
    for (const cb of this.authListeners) cb(user);
  }

  getSchemaVersion(): Promise<number | null> {
    return this.schemaError ? Promise.reject(this.schemaError) : Promise.resolve(MAX_SCHEMA_VERSION);
  }
  getUser(): Promise<AuthUser | null> {
    this.getUserCalls += 1;
    return this.slowGetUser ?? Promise.resolve(this.user);
  }
  /** Whether anything (the auth gate) is listening for auth events. */
  get listening(): boolean {
    return this.authListeners.size > 0;
  }
  signIn(email: string): Promise<void> {
    const user = [A, B].find((u) => u.email === email);
    if (!user) return Promise.reject(new ApiError("Sign-in failed. Check your email and password.", "unauthorized"));
    this.switchTo(user);
    return Promise.resolve();
  }
  signOut(options?: { localOnly?: boolean }): Promise<SignOutResult> {
    this.signOutCalls.push(options);
    this.switchTo(null);
    return Promise.resolve({ serverRevoked: this.serverRevoked });
  }
  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
  onAuthChange(cb: (user: AuthUser | null) => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }
  listSessions(): Promise<SessionRow[]> {
    try {
      // The owner is fixed when the request goes out, as with a real token.
      const rows = (this.data.get(this.owner().id) ?? []).map((s) => ({ ...s }));
      if (this.holdA && this.user === A) return this.holdA.then(() => rows);
      return Promise.resolve(rows);
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }
  getSession(id: string): Promise<SessionRow | null> {
    return this.listSessions().then((rows) => rows.find((s) => s.id === id) ?? null);
  }
  listEvents(): Promise<SessionEventRow[]> {
    return Promise.resolve([]);
  }
  listMessages(): Promise<SessionMessageRow[]> {
    return Promise.resolve([]);
  }
  listHosts(): Promise<HostRow[]> {
    try {
      const owner = this.owner();
      const now = new Date().toISOString();
      return Promise.resolve([
        { id: hostId(owner), owner_id: owner.id, name: `Laptop ${owner.email}`, platform: "simulated", connector_version: "test", remote_control_allowed: false, last_seen_at: now, provider_error_since: null, paired_at: T0, revoked_at: null, created_at: T0 },
      ]);
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }
  createHostPairing(): Promise<PairingTicket> {
    return Promise.reject(new Error("not used"));
  }
  revokeHost(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  getNotificationPrefs(): Promise<NotificationPrefs | null> {
    try {
      const owner = this.owner();
      this.prefsCalls.set(owner.id, (this.prefsCalls.get(owner.id) ?? 0) + 1);
      return Promise.resolve(null);
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }
  saveNotificationPrefs(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  subscribe(_cb: (topic: ChangeTopic) => void): () => void {
    return () => undefined;
  }
}

let api: FakeApi;
let queryClient: QueryClient;

function setBackend(kind: BackendKind): void {
  api = new FakeApi(kind);
  backend.api = api;
}

beforeEach(() => {
  window.localStorage.clear();
  notifications.closed = 0;
  setBackend("supabase");
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderApp(path = "/"): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const pageText = (): string => document.body.textContent ?? "";
const cachedKeys = (): (readonly unknown[])[] => queryClient.getQueryCache().findAll().map((q) => q.queryKey);
const storedAlerts = (user: AuthUser): unknown[] => JSON.parse(window.localStorage.getItem(alertStorageKey(api.kind, user.id)) ?? "[]") as unknown[];

async function signedInAs(title: string): Promise<void> {
  await waitFor(() => expect(pageText()).toContain(title), { timeout: 5000 });
}

async function onSignInPage(): Promise<void> {
  expect(await screen.findByRole("heading", { name: "Sign in" }, { timeout: 5000 })).toBeTruthy();
}

function signInWith(user: AuthUser): void {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

const NAMES_KEY_PREFIX = "tavro.systemNotificationNames.v1:";

/** One stored alert for `user` (ids and kinds only, as the app stores them), plus the names opt-in. */
function seedAlert(user: AuthUser): void {
  const key = alertStorageKey(api.kind, user.id);
  new AlertStore(window.localStorage, key).add([{ id: `host_disconnected:${hostId(user)}:${T0}`, kind: "host_disconnected", sessionId: null, hostId: hostId(user), at: T0, isDemo: true }]);
  window.localStorage.setItem(NAMES_KEY_PREFIX + key, "on");
}

describe("switching accounts without signing out", () => {
  it("never shows A's data under B, refetches B's preferences and raises no alert", async () => {
    renderApp();
    await signedInAs(A_TITLE);
    await waitFor(() => expect(api.prefsCalls.get(A.id)).toBe(1));

    // From the switch on, record whether A's title is ever in the document.
    let leaked = false;
    const observer = new MutationObserver(() => {
      if (pageText().includes(A_TITLE)) leaked = true;
    });
    act(() => api.switchTo(B));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    try {
      expect(pageText()).not.toContain(A_TITLE);
      await signedInAs(B_TITLE);
      await waitFor(() => expect(api.prefsCalls.get(B.id)).toBe(1));
    } finally {
      observer.disconnect();
    }
    expect(leaked).toBe(false);
    expect(pageText()).not.toContain(A_TITLE);

    // Nothing keyed to A is left in the cache; every user-data key names B.
    const keys = cachedKeys();
    expect(keys.some((k) => k.includes(A.id))).toBe(false);
    expect(keys.filter((k) => k[0] !== "schema").every((k) => k.includes(B.id))).toBe(true);

    // B's approval-needed session was there before B's first load: a baseline, not an alert.
    expect(storedAlerts(B)).toEqual([]);
  });
});

describe("expired authentication", () => {
  it("returns to sign-in with a notice and clears user data when a query is unauthorized", async () => {
    renderApp();
    await signedInAs(A_TITLE);

    api.failWith = new ApiError("Your sign-in has expired. Please sign in again.", "unauthorized");
    await act(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }));

    expect(await screen.findByRole("heading", { name: "Sign in" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(EXPIRED_NOTICE);
    expect(pageText()).not.toContain(A_TITLE);
    expect(cachedKeys().every((k) => k[0] === "schema")).toBe(true);
    // Signed out locally, once: the follow-up auth event does not repeat it.
    expect(api.signOutCalls).toEqual([{ localOnly: true }]);

    // Signing in again clears the notice.
    api.failWith = null;
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: A.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await signedInAs(A_TITLE);
    expect(pageText()).not.toContain(EXPIRED_NOTICE);
  });

  it("ignores an unauthorized error from another user's query (a late 401 after switching)", async () => {
    renderApp();
    await signedInAs(A_TITLE);
    // A query cached under someone else's id fails as unauthorized: it must not sign A out.
    await act(async () => {
      await queryClient
        .fetchQuery({
          queryKey: ["sessions", "supabase", "someone-else", "list"],
          queryFn: () => Promise.reject(new ApiError("Your sign-in has expired. Please sign in again.", "unauthorized")),
          retry: false,
        })
        .catch(() => undefined);
    });
    expect(api.signOutCalls).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect(pageText()).toContain(A_TITLE);
  });

  it("never expires demo data", async () => {
    setBackend("demo");
    renderApp();
    await signedInAs(A_TITLE);

    api.failWith = new ApiError("Please sign in.", "unauthorized");
    await act(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }));
    await waitFor(() => expect(queryClient.getQueryCache().find({ queryKey: ["sessions"], exact: false })?.state.status).toBe("error"));

    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect(pageText()).not.toContain(EXPIRED_NOTICE);
    expect(api.signOutCalls).toEqual([]);
  });
});

describe("sign out, then sign in again", () => {
  it("signs the same user back in with freshly fetched data", async () => {
    renderApp();
    await signedInAs(A_TITLE);
    await waitFor(() => expect(api.prefsCalls.get(A.id)).toBe(1));

    await act(() => api.signOut());
    expect(await screen.findByRole("heading", { name: "Sign in" }, { timeout: 5000 })).toBeTruthy();
    expect(pageText()).not.toContain(A_TITLE);
    expect(pageText()).not.toContain(EXPIRED_NOTICE);
    expect(cachedKeys().every((k) => k[0] === "schema")).toBe(true);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: A.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await signedInAs(A_TITLE);
    await waitFor(() => expect(api.prefsCalls.get(A.id)).toBe(2));
  });
});

describe("races with auth events", () => {
  /**
   * The race needs getUser in flight and the gate listening. "Connecting…"
   * alone doesn't show that: findBy* leaves the commit's effects (where the
   * gate calls getUser and subscribes) to React's scheduler, so an event
   * fired straight after it could reach no listener.
   */
  async function gateWaitingForGetUser(): Promise<void> {
    await waitFor(() => expect([api.getUserCalls, api.listening]).toEqual([1, true]));
  }

  it("a slow getUser for A that answers after a sign-out does not sign A back in", async () => {
    const slow = deferred<AuthUser | null>();
    api.slowGetUser = slow.promise;
    renderApp();
    expect(await screen.findByText("Connecting…", undefined, { timeout: 5000 })).toBeTruthy();
    await gateWaitingForGetUser();

    act(() => api.switchTo(null));
    await onSignInPage();
    await act(async () => {
      slow.resolve(A);
      await slow.promise;
    });
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(pageText()).not.toContain(A_TITLE);
    expect(cachedKeys().every((k) => k[0] === "schema")).toBe(true);
  });

  it("a slow getUser for A that answers after B signed in leaves B in place", async () => {
    const slow = deferred<AuthUser | null>();
    api.slowGetUser = slow.promise;
    renderApp();
    expect(await screen.findByText("Connecting…", undefined, { timeout: 5000 })).toBeTruthy();
    await gateWaitingForGetUser();

    act(() => api.switchTo(B));
    await signedInAs(B_TITLE);
    await act(async () => {
      slow.resolve(A);
      await slow.promise;
    });
    expect(pageText()).toContain(B_TITLE);
    expect(pageText()).not.toContain(A_TITLE);
    expect(cachedKeys().some((k) => k.includes(A.id))).toBe(false);
  });

  it("A's response still in flight when B signs in is never written into B's view", async () => {
    renderApp();
    await signedInAs(A_TITLE);
    const hold = deferred<undefined>();
    api.holdA = hold.promise;
    // A's refetch goes out and hangs.
    act(() => void queryClient.invalidateQueries({ queryKey: ["sessions"] }));
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ["sessions"] })).toBeGreaterThan(0));

    act(() => api.switchTo(B));
    await signedInAs(B_TITLE);
    await act(async () => {
      hold.resolve(undefined);
      await hold.promise;
    });
    expect(pageText()).toContain(B_TITLE);
    expect(pageText()).not.toContain(A_TITLE);
    expect(cachedKeys().some((k) => k.includes(A.id))).toBe(false);
  });
});

describe("another tab", () => {
  it("Sign out in another tab: this tab drops A's data and cache, closes notifications and sees the cleared list", async () => {
    seedAlert(A);
    renderApp();
    await signedInAs(A_TITLE);
    const closedBefore = notifications.closed;

    // What the other tab's Sign out does to shared storage, then auth-js's broadcast SIGNED_OUT.
    const key = alertStorageKey(api.kind, A.id);
    act(() => {
      window.localStorage.setItem(key, "[]");
      window.dispatchEvent(new StorageEvent("storage", { key }));
      api.switchTo(null);
    });
    await onSignInPage();
    expect(pageText()).not.toContain(A_TITLE);
    expect(cachedKeys().every((k) => k[0] === "schema")).toBe(true);
    expect(notifications.closed).toBeGreaterThan(closedBefore);
    expect(storedAlerts(A)).toEqual([]);
  });

  it("a sign-in that ended in another tab (expiry, failed refresh) keeps A's history for A's return", async () => {
    seedAlert(A);
    renderApp();
    await signedInAs(A_TITLE);

    act(() => api.switchTo(null));
    await onSignInPage();
    expect(pageText()).not.toContain(A_TITLE);
    expect(storedAlerts(A)).toHaveLength(1);

    signInWith(A);
    await signedInAs(A_TITLE);
    expect(storedAlerts(A)).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Alerts, 1 unread" }).length).toBeGreaterThan(0);
  });
});

describe("alert history across sign-ins", () => {
  it("keeps A's alerts after A's sign-in expires and A signs back in", async () => {
    seedAlert(A);
    renderApp();
    await signedInAs(A_TITLE);

    api.failWith = new ApiError("Your sign-in has expired. Please sign in again.", "unauthorized");
    await act(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }));
    await onSignInPage();
    expect(storedAlerts(A)).toHaveLength(1);

    api.failWith = null;
    signInWith(A);
    await signedInAs(A_TITLE);
    expect(storedAlerts(A)).toHaveLength(1);
    expect(window.localStorage.getItem(NAMES_KEY_PREFIX + alertStorageKey(api.kind, A.id))).toBe("on");
  });

  it("removes A's alerts and names opt-in when B signs in after A's sign-in expired", async () => {
    seedAlert(A);
    renderApp();
    await signedInAs(A_TITLE);
    expect(window.localStorage.getItem(lastUserKey(api.kind))).toBe(A.id);

    api.failWith = new ApiError("Your sign-in has expired. Please sign in again.", "unauthorized");
    await act(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }));
    await onSignInPage();
    api.failWith = null;
    signInWith(B);
    await signedInAs(B_TITLE);

    expect(window.localStorage.getItem(alertStorageKey(api.kind, A.id))).toBeNull();
    expect(window.localStorage.getItem(NAMES_KEY_PREFIX + alertStorageKey(api.kind, A.id))).toBeNull();
    expect(window.localStorage.getItem(lastUserKey(api.kind))).toBe(B.id);
    expect(pageText()).not.toContain(A_TITLE);
  });

  it("Sign out in Settings clears A's history and signs out", async () => {
    seedAlert(A);
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }, { timeout: 5000 }));
    await onSignInPage();
    expect(api.signOutCalls).toEqual([undefined]);
    await waitFor(() => expect(storedAlerts(A)).toEqual([]));
    expect(pageText()).not.toContain(SERVER_NOT_TOLD_MESSAGE);
  });

  it("says so on the sign-in page when the server couldn't be told, until the next sign-in", async () => {
    api.serverRevoked = false;
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }, { timeout: 5000 }));
    await onSignInPage();
    expect((await screen.findByRole("alert")).textContent).toContain(SERVER_NOT_TOLD_MESSAGE);

    signInWith(A);
    // Still on Settings, signed in again.
    expect(await screen.findByRole("button", { name: "Sign out" }, { timeout: 5000 })).toBeTruthy();
    expect(pageText()).not.toContain(SERVER_NOT_TOLD_MESSAGE);
  });
});

describe("Change backend", () => {
  it("closes the backend being left (its stored sign-in goes with it)", async () => {
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Change backend" }, { timeout: 5000 }));
    await waitFor(() => expect(api.closeCalls).toBe(1));
    expect(pageText()).not.toContain(A_TITLE);
  });

  it("doesn't leave the user on the loading screen when the backend being left never finishes closing", async () => {
    // e.g. its sign-out waits on a refresh against an unreachable project
    const hang = vi.spyOn(api, "close").mockReturnValue(new Promise<void>(() => undefined));
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Change backend" }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Open demo" }, { timeout: 5000 }));
    expect(hang).toHaveBeenCalledOnce();
    // The next backend starts once CLOSE_WAIT_MS has passed.
    expect(await screen.findByRole("button", { name: "Sign out" }, { timeout: CLOSE_WAIT_MS + 3000 })).toBeTruthy();
  }, CLOSE_WAIT_MS + 6000);
});

describe("rejected publishable key", () => {
  const KEY_REJECTED = "Your Supabase project rejected this app's publishable key. If the key was rotated, choose Change backend and enter the current one.";

  it("shows a configuration error instead of sending the user to sign in, and can retry", async () => {
    renderApp();
    await signedInAs(A_TITLE);

    api.failWith = new ApiError(KEY_REJECTED, "misconfigured");
    await act(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }));
    expect(await screen.findByRole("heading", { name: "Connection key rejected" }, { timeout: 5000 })).toBeTruthy();
    expect(pageText()).toContain(KEY_REJECTED);
    expect(screen.getByRole("button", { name: "Change backend" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect(pageText()).not.toContain(EXPIRED_NOTICE);
    expect(pageText()).not.toContain(A_TITLE);
    expect(api.signOutCalls).toEqual([]);

    // Fixed (e.g. the key was restored): Try again brings the same account back.
    api.failWith = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await signedInAs(A_TITLE);
  });

  it("offers Sign out: ends the session locally, forgets A's history and says the server wasn't told", async () => {
    seedAlert(A);
    renderApp();
    await signedInAs(A_TITLE);

    api.failWith = new ApiError(KEY_REJECTED, "misconfigured");
    await act(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }));
    expect(await screen.findByRole("heading", { name: "Connection key rejected" }, { timeout: 5000 })).toBeTruthy();
    api.failWith = null;
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await onSignInPage();
    expect(api.signOutCalls).toEqual([{ localOnly: true }]);
    expect(window.localStorage.getItem(alertStorageKey(api.kind, A.id))).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain(SERVER_NOT_TOLD_MESSAGE);
  });

  it("names the problem on startup too", async () => {
    api.schemaError = new ApiError(KEY_REJECTED, "misconfigured");
    renderApp();
    expect(await screen.findByRole("heading", { name: "Connection key rejected" }, { timeout: 5000 })).toBeTruthy();
    expect(pageText()).toContain(KEY_REJECTED);
  });
});

describe("startup errors that aren't an outage", () => {
  it("a refused stored sign-in is named as such, and Sign in again drops it", async () => {
    api.schemaError = new ApiError("Your sign-in has expired. Please sign in again.", "unauthorized");
    renderApp();
    expect(await screen.findByRole("heading", { name: "Sign-in not accepted" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Can't reach your project" })).toBeNull();

    api.schemaError = null;
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await onSignInPage();
    expect(api.signOutCalls).toEqual([{ localOnly: true }]);
  });

  it("a refused permission and a rate limit are not blamed on reachability", async () => {
    api.schemaError = new ApiError("You are not allowed to do that.", "forbidden");
    renderApp();
    expect(await screen.findByRole("heading", { name: "Access refused" }, { timeout: 5000 })).toBeTruthy();
  });
});
