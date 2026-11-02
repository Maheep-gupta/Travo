// Authentication lifecycle through the real App shell: switching accounts
// without signing out (G2), expired authentication (G3), and signing in
// again after signing out. Only backend creation is swapped for a fake.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AuthUser, type BackendKind, type ChangeTopic, type TavroApi } from "@mc/api-client/demo";
import type { HostRow, NotificationPrefs, PairingTicket, SessionEventRow, SessionMessageRow, SessionRow, SessionStatus } from "@mc/contracts";
import { MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import { alertStorageKey } from "./alert-store.js";
import { ApiProvider } from "./api-context.js";
import { App } from "./App.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

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
  readonly prefsCalls = new Map<string, number>();
  readonly signOutCalls: ({ localOnly?: boolean } | undefined)[] = [];
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
    return Promise.resolve(MAX_SCHEMA_VERSION);
  }
  getUser(): Promise<AuthUser | null> {
    return Promise.resolve(this.user);
  }
  signIn(email: string): Promise<void> {
    const user = [A, B].find((u) => u.email === email);
    if (!user) return Promise.reject(new ApiError("Sign-in failed. Check your email and password.", "unauthorized"));
    this.switchTo(user);
    return Promise.resolve();
  }
  signOut(options?: { localOnly?: boolean }): Promise<void> {
    this.signOutCalls.push(options);
    this.switchTo(null);
    return Promise.resolve();
  }
  onAuthChange(cb: (user: AuthUser | null) => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }
  listSessions(): Promise<SessionRow[]> {
    try {
      return Promise.resolve((this.data.get(this.owner().id) ?? []).map((s) => ({ ...s })));
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
  setBackend("supabase");
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

function renderApp(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={["/"]}>
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
