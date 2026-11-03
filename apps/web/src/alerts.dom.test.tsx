// Component tests for the Tavro Alerts React wiring: the watcher inside
// AlertsProvider, the Alerts page and the unread indicator in the shell.
// The real ApiProvider is used; only backend creation is swapped for a fake.
import { useEffect, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, ChangeTopic, SignOutResult, TavroApi } from "@mc/api-client/demo";
import type { HostRow, NotificationPrefs, PairingTicket, SessionEventRow, SessionMessageRow, SessionRow, SessionStatus } from "@mc/contracts";
import { MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import type { TavroAlert } from "@mc/domain";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import { userKey } from "./hooks.js";
import { AlertsProvider, useAlerts } from "./alerts-context.js";
import { ApiProvider, useApi, useApiContext } from "./api-context.js";
import { App } from "./App.js";
import { AlertsPage } from "./pages/AlertsPage.js";

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

const USER: AuthUser = { id: "00000000-0000-4000-8000-000000000001", email: null };
const HOST = "00000000-0000-4000-8000-0000000000b1";
const S1 = "00000000-0000-4000-8000-000000000101";
const S2 = "00000000-0000-4000-8000-000000000102";
const T0 = "2026-10-29T10:00:00.000Z";

function sessionRow(id: string, title: string, status: SessionStatus, at = T0): SessionRow {
  return {
    id,
    owner_id: USER.id,
    host_id: HOST,
    provider: "mock",
    external_id: id,
    title,
    project_label: null,
    status,
    status_reason: null,
    status_source: "mock",
    last_activity_at: at,
    last_event_summary: null,
    capabilities: ["discover"],
    is_demo: true,
    started_at: T0,
    ended_at: null,
    updated_at: at,
  };
}

/** Minimal in-memory backend whose data and failures each test controls. */
class FakeApi implements TavroApi {
  readonly kind = "demo" as const;
  sessions: SessionRow[] = [sessionRow(S1, "Fix login", "running"), sessionRow(S2, "Refactor parser", "approval_required")];
  failHosts = false;
  failSessions = false;
  /** Lists that never answer, so their first load stays in progress. */
  holdSessions = false;
  holdHosts = false;
  failPrefs = false;
  /** Whose hosts the backend answers with (another tab's sign-in swaps the shared token). */
  hostsOwner = USER.id;
  prefs: NotificationPrefs | null = null;
  private readonly authListeners = new Set<(user: AuthUser | null) => void>();

  getSchemaVersion(): Promise<number | null> {
    return Promise.resolve(MAX_SCHEMA_VERSION);
  }
  getUser(): Promise<AuthUser | null> {
    return Promise.resolve(USER);
  }
  signIn(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  signOut(): Promise<SignOutResult> {
    return Promise.reject(new Error("not used"));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  onAuthChange(cb: (user: AuthUser | null) => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }
  emitAuth(user: AuthUser | null): void {
    for (const cb of this.authListeners) cb(user);
  }
  listSessions(): Promise<SessionRow[]> {
    if (this.holdSessions) return new Promise(() => undefined);
    if (this.failSessions) return Promise.reject(new Error("sessions unavailable"));
    return Promise.resolve(this.sessions.map((s) => ({ ...s })));
  }
  getSession(id: string): Promise<SessionRow | null> {
    return Promise.resolve(this.sessions.find((s) => s.id === id) ?? null);
  }
  listEvents(): Promise<SessionEventRow[]> {
    return Promise.resolve([]);
  }
  listMessages(): Promise<SessionMessageRow[]> {
    return Promise.resolve([]);
  }
  listHosts(): Promise<HostRow[]> {
    if (this.holdHosts) return new Promise(() => undefined);
    if (this.failHosts) return Promise.reject(new Error("hosts unavailable"));
    // Seen just now, so the host counts as online whenever the list is fetched.
    const now = new Date().toISOString();
    return Promise.resolve([
      { id: HOST, owner_id: this.hostsOwner, name: "Test laptop", platform: "simulated", connector_version: "test", remote_control_allowed: false, last_seen_at: now, provider_error_since: null, paired_at: T0, revoked_at: null, created_at: T0 },
    ]);
  }
  createHostPairing(): Promise<PairingTicket> {
    return Promise.reject(new Error("not used"));
  }
  revokeHost(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  getNotificationPrefs(): Promise<NotificationPrefs | null> {
    return this.failPrefs ? Promise.reject(new Error("prefs unavailable")) : Promise.resolve(this.prefs);
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

beforeEach(() => {
  api = new FakeApi();
  backend.api = api;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

/** Renders children once the real ApiProvider has picked up the fake backend. */
function ApiReady({ children }: { children: ReactNode }) {
  const { api: ready } = useApiContext();
  return ready ? children : <p>Starting test backend</p>;
}

function renderApp(ui: ReactNode, route = "/") {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const storageKey = alertStorageKey("demo", USER.id);

/** Fills the stored list the way detection would (one batch, newest event first). */
function prefillAlerts(alerts: TavroAlert[], read: string[] = []): void {
  const store = new AlertStore(window.localStorage, storageKey);
  store.add(alerts);
  for (const id of read) store.markRead(id);
}

function storedAlerts(): { id: string; read: boolean }[] {
  return JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as { id: string; read: boolean }[];
}

describe("AlertWatcher (via AlertsProvider)", () => {
  interface Counts {
    s: number;
    h: number;
    hErr: number;
    p: number;
    pErr: number;
  }

  /**
   * Observes the same queries as the watcher and publishes their update
   * counts from an effect. Effects of one commit run together, so once a
   * count shows up here the watcher has already handled that data.
   */
  function QueryProbe() {
    const a = useApi();
    const client = useQueryClient();
    // Subscribing re-renders this probe in the same batch as the watcher.
    useQuery({ queryKey: userKey(a, USER.id, "sessions", "list"), queryFn: () => a.listSessions() });
    useQuery({ queryKey: userKey(a, USER.id, "hosts"), queryFn: () => a.listHosts() });
    useQuery({ queryKey: userKey(a, USER.id, "prefs"), queryFn: () => a.getNotificationPrefs() });
    const sessions = client.getQueryState(userKey(a, USER.id, "sessions", "list"));
    const hosts = client.getQueryState(userKey(a, USER.id, "hosts"));
    const prefs = client.getQueryState(userKey(a, USER.id, "prefs"));
    const counts = JSON.stringify({
      s: sessions?.dataUpdateCount ?? 0,
      h: hosts?.dataUpdateCount ?? 0,
      hErr: hosts?.errorUpdateCount ?? 0,
      p: prefs?.dataUpdateCount ?? 0,
      pErr: prefs?.errorUpdateCount ?? 0,
    } satisfies Counts);
    const [committed, setCommitted] = useState("");
    useEffect(() => setCommitted(counts), [counts]);
    return <output data-testid="probe">{committed}</output>;
  }

  function AlertIds() {
    const alerts = useAlerts();
    return <output data-testid="alerts">{alerts.map((x) => x.id).join(" ")}</output>;
  }

  function renderWatcher() {
    renderApp(
      <ApiReady>
        <AlertsProvider userId={USER.id}>
          <QueryProbe />
          <AlertIds />
        </AlertsProvider>
      </ApiReady>,
    );
  }

  const counts = (): Counts => JSON.parse(screen.getByTestId("probe").textContent || "{}") as Counts;
  const alertIds = (): string[] => (screen.getByTestId("alerts").textContent ?? "").split(" ").filter(Boolean);

  /** Waits until the probe has committed a state that satisfies `ok`. */
  async function settled(ok: (c: Counts) => boolean): Promise<void> {
    await waitFor(() => expect(ok(counts())).toBe(true), { timeout: 5000 });
  }

  async function initialLoad(): Promise<void> {
    renderWatcher();
    await settled((c) => c.s >= 1 && c.h >= 1 && c.p >= 1);
  }

  async function refetch(queryKey: string[], ok: (before: Counts, now: Counts) => boolean): Promise<void> {
    const before = counts();
    await act(() => queryClient.invalidateQueries({ queryKey }));
    await settled((now) => ok(before, now));
  }

  const approvalId = (at: string) => `s:${S1}:approval_required:${at}`;
  const T1 = "2026-10-29T11:00:00.000Z";

  it("treats the first load as a baseline and raises no alerts", async () => {
    await initialLoad();
    // S2 already needed approval before Tavro opened: not an alert.
    expect(alertIds()).toEqual([]);
    expect(storedAlerts()).toEqual([]);
  });

  it("raises exactly one alert when a session starts needing approval, and none on an identical refetch", async () => {
    await initialLoad();

    api.sessions = [sessionRow(S1, "Fix login", "approval_required", T1), api.sessions[1] as SessionRow];
    await refetch(["sessions"], (b, n) => n.s > b.s);
    expect(alertIds()).toEqual([approvalId(T1)]);
    // Announced to screen readers because the page is visible (jsdom pretends to be).
    expect((await screen.findByText("New alert: Needs approval")).getAttribute("aria-live")).toBe("polite");

    // Same data again (hosts too, which re-runs detection with a fresh fetch time).
    await refetch(["sessions"], (b, n) => n.s >= b.s);
    await refetch(["hosts"], (b, n) => n.h > b.h);
    expect(alertIds()).toEqual([approvalId(T1)]);
    expect(storedAlerts()).toHaveLength(1);
  });

  it("shows one system notification for simultaneous alerts while the tab is hidden", async () => {
    const created: { title: string; options?: NotificationOptions }[] = [];
    const Fake = Object.assign(
      function (this: unknown, title: string, options?: NotificationOptions) {
        created.push({ title, options });
        return { close: () => undefined };
      },
      { permission: "granted" as NotificationPermission, requestPermission: () => Promise.resolve("granted" as NotificationPermission) },
    );
    vi.stubGlobal("Notification", Fake);
    vi.stubGlobal("isSecureContext", true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    window.localStorage.setItem("tavro.systemNotifications.v1", "on");
    try {
      await initialLoad();
      api.sessions = [sessionRow(S1, "Fix login", "failed", T1), sessionRow(S2, "Refactor parser", "completed", T1)];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      expect(alertIds()).toHaveLength(2);
      expect(created).toEqual([{ title: "Tavro demo · 2 new alerts", options: expect.objectContaining({ body: "1 failed, 1 completed.", tag: "tavro:summary", silent: false }) }]);

      // A later run in the same burst: an approval is never silent, and the summary counts everything.
      api.sessions = [sessionRow(S1, "Fix login", "approval_required", "2026-10-29T11:05:00.000Z"), sessionRow(S2, "Refactor parser", "completed", T1)];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      expect(created).toHaveLength(2);
      expect(created[1]).toEqual({ title: "Tavro demo · 3 new alerts", options: expect.objectContaining({ body: "1 needs approval, 1 failed, 1 completed.", silent: false }) });
    } finally {
      visibility.mockRestore();
      vi.unstubAllGlobals();
      window.localStorage.removeItem("tavro.systemNotifications.v1");
    }
  });

  // G32 / QA LOW-3: the user's hidden tabs share one burst through storage.
  describe("bursts across tabs", () => {
    const burstKey = new AlertStore(window.localStorage, storageKey).burstKey;
    let created: { title: string; options?: NotificationOptions; close: () => void }[];
    let visibility: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      created = [];
      const Fake = Object.assign(
        function (this: unknown, title: string, options?: NotificationOptions) {
          const n = { title, options, tag: options?.tag, close: vi.fn() };
          created.push(n);
          return n;
        },
        { permission: "granted" as NotificationPermission, requestPermission: () => Promise.resolve("granted" as NotificationPermission) },
      );
      vi.stubGlobal("Notification", Fake);
      vi.stubGlobal("isSecureContext", true);
      visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      window.localStorage.setItem("tavro.systemNotifications.v1", "on");
    });

    afterEach(() => {
      visibility.mockRestore();
      vi.unstubAllGlobals();
    });

    /** What another tab leaves behind after notifying one completion just now. */
    const otherTabsSingle = () => {
      const now = Date.now();
      return JSON.stringify({ summary: { counts: { completed: 1 }, total: 1, allDemo: true }, lastShownAt: now, lastAudibleAt: now });
    };

    it("continues another tab's burst, so more of the same stays silent", async () => {
      await initialLoad();
      window.localStorage.setItem(burstKey, otherTabsSingle());
      api.sessions = [sessionRow(S1, "Fix login", "completed", T1), api.sessions[1] as SessionRow];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      // Per tab, this would have been a second audible single.
      expect(created.map((c) => [c.title, c.options?.tag, c.options?.silent])).toEqual([["Tavro demo · 2 new alerts", "tavro:summary", true]]);
      const stored = JSON.parse(window.localStorage.getItem(burstKey) ?? "null") as { summary: { total: number } };
      expect(stored.summary.total).toBe(2);
      // Counts, kinds and times only.
      expect(window.localStorage.getItem(burstKey)).not.toContain(S1);
    });

    it("still sounds for an approval that arrives in another tab's burst", async () => {
      await initialLoad();
      window.localStorage.setItem(burstKey, otherTabsSingle());
      api.sessions = [sessionRow(S1, "Fix login", "approval_required", T1), api.sessions[1] as SessionRow];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      expect(created.map((c) => [c.options?.tag, c.options?.silent])).toEqual([["tavro:summary", false]]);
    });

    it("closes its own single when another tab's summary counts it, and ends the burst for all tabs once looked at", async () => {
      await initialLoad();
      api.sessions = [sessionRow(S1, "Fix login", "failed", T1), api.sessions[1] as SessionRow];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      const [single] = created;
      expect(single?.options?.tag).toBe("tavro:failed");

      const now = Date.now();
      const summary = JSON.stringify({ summary: { counts: { failed: 1, completed: 1 }, total: 2, allDemo: true }, lastShownAt: now, lastAudibleAt: now });
      act(() => window.dispatchEvent(new StorageEvent("storage", { key: burstKey, newValue: summary })));
      expect(single?.close).toHaveBeenCalled();

      // Looking at this tab ends the burst in storage too, so the next alert anywhere is news again.
      window.localStorage.setItem(burstKey, summary);
      visibility.mockReturnValue("visible");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(window.localStorage.getItem(burstKey)).toBeNull();
    });

    it("closes its notifications when another tab ends the burst, but not for an unreadable or expired value", async () => {
      await initialLoad();
      api.sessions = [sessionRow(S1, "Fix login", "failed", T1), api.sessions[1] as SessionRow];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      const [single] = created;
      expect(single?.options?.tag).toBe("tavro:failed");

      const old = Date.now() - 2 * 60 * 60_000;
      for (const garbage of ["{not json", '{"summary":null}', JSON.stringify({ summary: { counts: { failed: 2 }, total: 2, allDemo: true }, lastShownAt: old, lastAudibleAt: old })]) {
        act(() => window.dispatchEvent(new StorageEvent("storage", { key: burstKey, newValue: garbage })));
      }
      expect(single?.close).not.toHaveBeenCalled();

      // A removal is the user looking at Tavro in another tab.
      act(() => window.dispatchEvent(new StorageEvent("storage", { key: burstKey, newValue: null })));
      expect(single?.close).toHaveBeenCalled();
    });

    it("records nothing in the shared burst when the browser refuses to show the notification", async () => {
      vi.stubGlobal(
        "Notification",
        Object.assign(
          function () {
            throw new TypeError("Illegal constructor");
          },
          { permission: "granted" as NotificationPermission, requestPermission: () => Promise.resolve("granted" as NotificationPermission) },
        ),
      );
      await initialLoad();
      api.sessions = [sessionRow(S1, "Fix login", "failed", T1), sessionRow(S2, "Refactor parser", "completed", T1)];
      await refetch(["sessions"], (b, n) => n.s > b.s);
      expect(alertIds()).toHaveLength(2);
      // Another tab would otherwise close its own notifications for a summary nobody sees.
      expect(window.localStorage.getItem(burstKey)).toBeNull();
    });
  });

  it("ends a stored burst when it opens (or reloads) while visible", async () => {
    const key = new AlertStore(window.localStorage, storageKey).burstKey;
    const now = Date.now();
    window.localStorage.setItem(key, JSON.stringify({ summary: { counts: { completed: 3 }, total: 3, allDemo: true }, lastShownAt: now, lastAudibleAt: now }));
    await initialLoad();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  // Two of the user's tabs, each with its own watcher, backend and query cache,
  // sharing one local storage. jsdom has one window and one document, so each
  // tab's storage and visibility listeners are captured as it mounts, and
  // storage events are delivered by hand to the other tab only, as a browser does.
  describe("two tabs sharing one burst (integration)", () => {
    interface Tab {
      name: string;
      api: FakeApi;
      client: QueryClient;
      container: HTMLElement;
      storage: Set<(e: StorageEvent) => void>;
      visibility: Set<() => void>;
    }
    const burstKey = new AlertStore(window.localStorage, storageKey).burstKey;
    let tabs: Tab[];
    let mounting: Tab | null;
    let acting: Tab | null;
    let created: { tab: string | undefined; tag: string | undefined; silent: boolean | null | undefined; close: () => void }[];
    let visibility: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tabs = [];
      mounting = null;
      acting = null;
      created = [];
      const Fake = Object.assign(
        function (this: unknown, _title: string, options?: NotificationOptions) {
          const n = { tab: acting?.name, tag: options?.tag, silent: options?.silent, close: vi.fn() };
          created.push(n);
          return n;
        },
        { permission: "granted" as NotificationPermission, requestPermission: () => Promise.resolve("granted" as NotificationPermission) },
      );
      vi.stubGlobal("Notification", Fake);
      vi.stubGlobal("isSecureContext", true);
      visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      window.localStorage.setItem("tavro.systemNotifications.v1", "on");
      const addWindow = window.addEventListener.bind(window);
      vi.spyOn(window, "addEventListener").mockImplementation(((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        if (type === "storage" && mounting) mounting.storage.add(listener as (e: StorageEvent) => void);
        else addWindow(type, listener, options);
      }) as typeof window.addEventListener);
      const addDocument = document.addEventListener.bind(document);
      vi.spyOn(document, "addEventListener").mockImplementation(((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        if (type === "visibilitychange" && mounting) mounting.visibility.add(listener as () => void);
        else addDocument(type, listener, options);
      }) as typeof document.addEventListener);
    });

    afterEach(() => {
      for (const t of tabs) t.client.clear();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    const probe = (tab: Tab): Counts => JSON.parse(within(tab.container).getByTestId("probe").textContent || "{}") as Counts;

    async function openTab(name: string): Promise<Tab> {
      const tab: Tab = { name, api: new FakeApi(), client: new QueryClient({ defaultOptions: { queries: { retry: false } } }), container: document.createElement("div"), storage: new Set(), visibility: new Set() };
      document.body.append(tab.container);
      backend.api = tab.api;
      mounting = tab;
      render(
        <QueryClientProvider client={tab.client}>
          <ApiProvider>
            <MemoryRouter>
              <ApiReady>
                <AlertsProvider userId={USER.id}>
                  <QueryProbe />
                </AlertsProvider>
              </ApiReady>
            </MemoryRouter>
          </ApiProvider>
        </QueryClientProvider>,
        { container: tab.container },
      );
      await waitFor(() => expect(probe(tab)).toMatchObject({ s: 1, h: 1, p: 1 }), { timeout: 5000 });
      mounting = null;
      tabs.push(tab);
      return tab;
    }

    /** Delivers a change to shared storage to every tab but the one that made it. */
    function deliver(from: Tab, before: string | null): void {
      const after = window.localStorage.getItem(burstKey);
      if (after === before) return;
      const event = new StorageEvent("storage", { key: burstKey, oldValue: before, newValue: after });
      for (const t of tabs) if (t !== from) act(() => t.storage.forEach((l) => l(event)));
    }

    /** One tab's sessions poll finds new data. */
    async function poll(tab: Tab, sessions: SessionRow[]): Promise<void> {
      const before = window.localStorage.getItem(burstKey);
      const was = probe(tab).s;
      tab.api.sessions = sessions;
      acting = tab;
      await act(() => tab.client.invalidateQueries({ queryKey: ["sessions"] }));
      await waitFor(() => expect(probe(tab).s).toBeGreaterThan(was), { timeout: 5000 });
      acting = null;
      deliver(tab, before);
    }

    const audible = () => created.filter((c) => c.silent !== true);
    const T2 = "2026-10-29T11:01:00.000Z";

    it("makes one sound for a storm split across both tabs", async () => {
      const [one, two] = [await openTab("one"), await openTab("two")];
      await poll(one, [sessionRow(S1, "Fix login", "completed", T1), sessionRow(S2, "Refactor parser", "approval_required")]);
      await poll(two, [sessionRow(S1, "Fix login", "running"), sessionRow(S2, "Refactor parser", "completed", T1)]);
      await poll(one, [sessionRow(S1, "Fix login", "running", T2), sessionRow(S2, "Refactor parser", "approval_required")]);
      await poll(one, [sessionRow(S1, "Fix login", "completed", T2), sessionRow(S2, "Refactor parser", "approval_required")]);
      expect(created.map((c) => [c.tab, c.tag, c.silent])).toEqual([
        ["one", "tavro:completed", undefined],
        ["two", "tavro:summary", true],
        ["one", "tavro:summary", true],
      ]);
      expect(audible()).toHaveLength(1);
      expect((JSON.parse(window.localStorage.getItem(burstKey) ?? "null") as { summary: { total: number } }).summary.total).toBe(3);
    });

    it("still sounds for an approval that arrives in the other tab", async () => {
      const [one, two] = [await openTab("one"), await openTab("two")];
      await poll(one, [sessionRow(S1, "Fix login", "completed", T1), sessionRow(S2, "Refactor parser", "approval_required")]);
      await poll(two, [sessionRow(S1, "Fix login", "approval_required", T1), sessionRow(S2, "Refactor parser", "approval_required")]);
      expect(created.map((c) => [c.tab, c.tag, c.silent])).toEqual([
        ["one", "tavro:completed", undefined],
        ["two", "tavro:summary", false],
      ]);
      expect(audible()).toHaveLength(2);
    });

    it("ends the burst for both tabs when the first becomes visible", async () => {
      const [one, two] = [await openTab("one"), await openTab("two")];
      await poll(one, [sessionRow(S1, "Fix login", "completed", T1), sessionRow(S2, "Refactor parser", "approval_required")]);
      const [single] = created;

      // Only tab one is looked at; tab two hears of it through storage.
      const before = window.localStorage.getItem(burstKey);
      visibility.mockReturnValue("visible");
      act(() => one.visibility.forEach((l) => l()));
      visibility.mockReturnValue("hidden");
      expect(window.localStorage.getItem(burstKey)).toBeNull();
      deliver(one, before);
      expect(single?.close).toHaveBeenCalled();

      // Tab two's next alert is news again: an audible single, not "2 new alerts".
      await poll(two, [sessionRow(S1, "Fix login", "running"), sessionRow(S2, "Refactor parser", "completed", T1)]);
      expect(created.slice(1).map((c) => [c.tab, c.tag, c.silent])).toEqual([["two", "tavro:completed", undefined]]);
    });
  });

  it("pauses detection while preferences failed to load, without losing the change", async () => {
    await initialLoad();

    api.failPrefs = true;
    await refetch(["prefs"], (b, n) => n.pErr > b.pErr);
    api.sessions = [sessionRow(S1, "Fix login", "approval_required", T1), api.sessions[1] as SessionRow];
    await refetch(["sessions"], (b, n) => n.s > b.s);
    expect(alertIds()).toEqual([]);
    expect(storedAlerts()).toEqual([]);

    // Detection resumes from the last trusted snapshot once preferences load again.
    api.failPrefs = false;
    await refetch(["prefs"], (b, n) => n.p > b.p);
    expect(alertIds()).toEqual([approvalId(T1)]);
  });

  it("pauses detection while the host list failed to load, without losing the change", async () => {
    await initialLoad();

    api.failHosts = true;
    await refetch(["hosts"], (b, n) => n.hErr > b.hErr);
    api.sessions = [sessionRow(S1, "Fix login", "approval_required", T1), api.sessions[1] as SessionRow];
    await refetch(["sessions"], (b, n) => n.s > b.s);
    expect(alertIds()).toEqual([]);
    expect(storedAlerts()).toEqual([]);

    api.failHosts = false;
    await refetch(["hosts"], (b, n) => n.h > b.h);
    expect(alertIds()).toEqual([approvalId(T1)]);
  });

  // L3: tabs share the stored sign-in, so a sign-in in another tab can make
  // this tab's queries, still keyed to this user, answer as someone else.
  it("never baselines or stores alerts from another account's rows, and resumes on this user's", async () => {
    const OTHER = "00000000-0000-4000-8000-000000000002";
    await initialLoad();

    api.sessions = [{ ...sessionRow(S1, "Other's session", "failed", T1), owner_id: OTHER }];
    await refetch(["sessions"], (b, n) => n.s > b.s);
    expect(alertIds()).toEqual([]);
    expect(storedAlerts()).toEqual([]);

    api.sessions = [sessionRow(S1, "Fix login", "approval_required", T1), sessionRow(S2, "Refactor parser", "approval_required")];
    api.hostsOwner = OTHER;
    await refetch(["hosts"], (b, n) => n.h > b.h);
    await refetch(["sessions"], (b, n) => n.s > b.s);
    expect(alertIds()).toEqual([]);
    expect(storedAlerts()).toEqual([]);

    // Compared with the last snapshot of this user's own data, not the other account's.
    api.hostsOwner = USER.id;
    await refetch(["hosts"], (b, n) => n.h > b.h);
    expect(alertIds()).toEqual([approvalId(T1)]);
  });

  // M2: auth-js reports expiry, a failed refresh and another tab's sign-out as
  // the same "signed out" event; the history is kept for the same person's
  // return. Sign out in Settings and a different user clear it (auth.dom.test).
  it("keeps stored alerts when the sign-in merely ends", async () => {
    prefillAlerts([{ id: "old-alert", kind: "failed", sessionId: S1, hostId: HOST, at: T0, isDemo: true }]);
    await initialLoad();
    expect(alertIds()).toEqual(["old-alert"]);

    act(() => api.emitAuth(null));
    expect(storedAlerts().map((a) => a.id)).toEqual(["old-alert"]);
  });

  it("clears stored alerts when a different user signs in", async () => {
    prefillAlerts([{ id: "old-alert", kind: "failed", sessionId: S1, hostId: HOST, at: T0, isDemo: true }]);
    await initialLoad();

    act(() => api.emitAuth({ id: "00000000-0000-4000-8000-000000000002", email: null }));
    expect(alertIds()).toEqual([]);
    expect(storedAlerts()).toEqual([]);
  });
});

describe("AlertsPage", () => {
  const failed: TavroAlert = { id: "a-failed", kind: "failed", sessionId: S1, hostId: HOST, at: "2026-10-29T10:00:00.000Z", isDemo: true };
  const approval: TavroAlert = { id: "a-approval", kind: "approval_required", sessionId: S2, hostId: HOST, at: "2026-10-29T12:00:00.000Z", isDemo: true };
  const hostDown: TavroAlert = { id: "a-host", kind: "host_disconnected", sessionId: null, hostId: HOST, at: "2026-10-29T11:00:00.000Z", isDemo: true };

  function SessionRoute() {
    const { id } = useParams();
    return <p>Session route {id}</p>;
  }

  function renderPage() {
    renderApp(
      <ApiReady>
        <AlertsProvider userId={USER.id}>
          <Routes>
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/sessions/:id" element={<SessionRoute />} />
            <Route path="/hosts" element={<p>Hosts route</p>} />
          </Routes>
        </AlertsProvider>
      </ApiReady>,
      "/alerts",
    );
  }

  /** Waits until names from live data are shown, so items have their final text. */
  async function renderPrefilled() {
    prefillAlerts([failed, approval, hostDown], [hostDown.id]);
    renderPage();
    await screen.findByRole("link", { name: /Needs approval.*Refactor parser/ }, { timeout: 5000 });
  }

  const alertLinks = () => screen.getAllByRole("link").filter((l) => l.classList.contains("alert-link"));

  it("lists alerts newest first and marks unread ones", async () => {
    await renderPrefilled();
    const links = alertLinks();
    expect(links.map((l) => l.textContent)).toEqual([
      "Needs approvalRefactor parser (unread)",
      "Host disconnectedTest laptop",
      "FailedFix login (unread)",
    ]);
    expect(screen.getByRole("heading", { level: 2, name: /2 unread/ })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.classList.contains("unread"))).toEqual([true, false, true]);
  });

  it("links session alerts to the session and host alerts to hosts", async () => {
    await renderPrefilled();
    const [first, second] = alertLinks();
    expect(first?.getAttribute("href")).toBe(`/sessions/${S2}`);
    expect(second?.getAttribute("href")).toBe("/hosts");

    fireEvent.click(first as HTMLElement);
    expect(await screen.findByText(`Session route ${S2}`)).toBeTruthy();
    // Opening an alert marks it read.
    expect(storedAlerts().find((a) => a.id === approval.id)?.read).toBe(true);
  });

  it("marks all alerts read", async () => {
    await renderPrefilled();
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("heading", { level: 2, name: /All read/ })).toBeTruthy();
    expect(alertLinks().some((l) => l.textContent?.includes("(unread)"))).toBe(false);
    expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
    expect(storedAlerts().every((a) => a.read)).toBe(true);
  });

  it("clears all alerts only after confirmation", async () => {
    await renderPrefilled();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(alertLinks()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(alertLinks()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Confirm clear all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear all" }));
    expect(screen.getByRole("heading", { name: "No alerts" })).toBeTruthy();
    expect(storedAlerts()).toEqual([]);
  });

  it("dismisses a single alert with a descriptive button", async () => {
    await renderPrefilled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss alert: Failed, Fix login" }));
    expect(alertLinks().map((l) => l.textContent)).toEqual(["Needs approvalRefactor parser (unread)", "Host disconnectedTest laptop"]);
    expect(storedAlerts().map((a) => a.id)).toEqual([approval.id, hostDown.id]);
  });

  describe("bursts", () => {
    const done = (id: string, sessionId: string, minute: number): TavroAlert => ({
      id,
      kind: "completed",
      sessionId,
      hostId: HOST,
      at: `2026-10-29T12:0${minute}:00.000Z`,
      isDemo: true,
    });
    const burst = [done("d1", S1, 1), done("d2", S2, 2), done("d3", S1, 3)];

    async function renderBurst() {
      prefillAlerts([...burst, approval], ["d1"]);
      renderPage();
      // Names come from live data; wait for them so rows have their final text.
      await screen.findByRole("link", { name: /Needs approval.*Refactor parser/ }, { timeout: 5000 });
      return screen.getByRole("button", { name: /^Completed · 3 alerts/ });
    }

    it("folds related alerts into one row but keeps approvals separate and the unread count exact", async () => {
      const toggle = await renderBurst();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toContain("(2 unread)");
      // The approval is its own row, never folded.
      expect(alertLinks().map((l) => l.textContent)).toEqual(["Needs approvalRefactor parser (unread)"]);
      expect(screen.getByRole("heading", { level: 2, name: /3 unread · 4 total/ })).toBeTruthy();
    });

    it("expands to the individual alerts, each still readable and dismissable on its own", async () => {
      fireEvent.click(await renderBurst());
      expect(screen.getByRole("button", { name: /^Completed · 3 alerts/ }).getAttribute("aria-expanded")).toBe("true");
      expect(alertLinks()).toHaveLength(4);

      // Dismiss the oldest member: the group's id changes, but it stays open.
      const oldest = screen.getAllByRole("button", { name: "Dismiss alert: Completed, Fix login" }).at(-1);
      fireEvent.click(oldest as HTMLElement);
      expect(storedAlerts().map((a) => a.id)).toEqual(["d3", "d2", approval.id]);
      expect(screen.getByRole("button", { name: /^Completed · 2 alerts/ }).getAttribute("aria-expanded")).toBe("true");
      expect(alertLinks()).toHaveLength(3);
    });

    it("marks a whole group read, and dismisses it, in one action", async () => {
      await renderBurst();
      fireEvent.click(screen.getByRole("button", { name: "Mark 2 read" }));
      expect(storedAlerts().filter((a) => a.id.startsWith("d")).every((a) => a.read)).toBe(true);
      expect(storedAlerts().find((a) => a.id === approval.id)?.read).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Dismiss 3 alerts: Completed · 3 alerts, Test laptop" }));
      expect(storedAlerts().map((a) => a.id)).toEqual([approval.id]);
    });
  });

  // Accessibility review: focus never drops to <body> when the focused control
  // goes away (WCAG 2.4.3), and actions are announced.
  describe("focus and announcements", () => {
    const said = () => document.querySelector("main [role='status'].sr-only")?.textContent ?? "";
    const press = (el: HTMLElement) => {
      el.focus();
      fireEvent.click(el);
    };
    const link = (name: RegExp) => screen.getByRole("link", { name });

    it("moves focus to the next row after a dismiss, or to the list heading when there is none", async () => {
      await renderPrefilled();
      press(screen.getByRole("button", { name: "Dismiss alert: Needs approval, Refactor parser" }));
      expect(document.activeElement).toBe(link(/Host disconnected/));
      expect(said()).toBe("Alert dismissed");

      press(screen.getByRole("button", { name: "Dismiss alert: Failed, Fix login" }));
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: /total/ }));
      // The same message again is still new text for screen readers.
      expect(said().trim()).toBe("Alert dismissed");
      expect(said()).not.toBe("Alert dismissed");

      press(screen.getByRole("button", { name: "Dismiss alert: Host disconnected, Test laptop" }));
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "No alerts" }));
    });

    it("keeps focus on the row when Mark read removes its button, and on the heading after Mark all read", async () => {
      await renderPrefilled();
      press(screen.getAllByRole("button", { name: "Mark read" })[0] as HTMLElement);
      expect(document.activeElement).toBe(link(/Needs approval/));
      expect(said()).toBe("Alert marked read");

      press(screen.getByRole("button", { name: "Mark all read" }));
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: /All read/ }));
      expect(said()).toBe("All alerts marked read");
    });

    it("moves focus through Clear all, Cancel and Confirm", async () => {
      await renderPrefilled();
      press(screen.getByRole("button", { name: "Clear all" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm clear all" }));
      press(screen.getByRole("button", { name: "Cancel" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear all" }));

      press(screen.getByRole("button", { name: "Clear all" }));
      press(screen.getByRole("button", { name: "Confirm clear all" }));
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "No alerts" }));
      expect(said()).toBe("All alerts cleared");
    });

    it("moves focus past a dismissed group, and keeps the separator out of its time element", async () => {
      prefillAlerts([
        { id: "d1", kind: "completed", sessionId: S1, hostId: HOST, at: "2026-10-29T12:01:00.000Z", isDemo: true },
        { id: "d2", kind: "completed", sessionId: S2, hostId: HOST, at: "2026-10-29T12:02:00.000Z", isDemo: true },
        approval,
      ]);
      renderPage();
      await screen.findByRole("link", { name: /Needs approval.*Refactor parser/ }, { timeout: 5000 });
      const group = screen.getByRole("button", { name: /^Completed · 2 alerts/ }).closest("li") as HTMLElement;
      expect(group.querySelector("time")?.textContent).not.toContain("·");

      press(screen.getByRole("button", { name: "Mark 2 read" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Completed · 2 alerts/ }));
      expect(said()).toBe("2 alerts marked read");

      press(screen.getByRole("button", { name: /^Dismiss 2 alerts/ }));
      expect(document.activeElement).toBe(link(/Needs approval/));
      expect(said()).toBe("2 alerts dismissed");
    });
  });

  // G26 (spec 5.5): "no longer listed" only once the list loaded without it.
  describe("names while lists load or fail", () => {
    const names = () => alertLinks().map((l) => l.querySelector(".alert-name")?.textContent);

    it("says a name is loading while its list is on its first load", async () => {
      api.holdSessions = true;
      api.holdHosts = true;
      prefillAlerts([failed, hostDown]);
      renderPage();
      await screen.findByRole("heading", { level: 2, name: /total/ }, { timeout: 5000 });
      expect(names()).toEqual(["Loading name…", "Loading name…"]);
      expect(screen.queryByText(/no longer listed/)).toBeNull();
    });

    it("keeps session names loading until the host list has loaded too (the views wait for it)", async () => {
      api.holdHosts = true;
      prefillAlerts([failed]);
      renderPage();
      await screen.findByRole("heading", { level: 2, name: /total/ }, { timeout: 5000 });
      // Give the session list time to arrive; its name still waits for the hosts.
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(names()).toEqual(["Loading name…"]);
    });

    it("says a name is unavailable when its list failed to load", async () => {
      api.failSessions = true;
      api.failHosts = true;
      prefillAlerts([failed, hostDown]);
      renderPage();
      await waitFor(() => expect(names()).toEqual(["Name unavailable", "Name unavailable"]), { timeout: 5000 });
      expect(screen.getByRole("button", { name: "Dismiss alert: Failed, Name unavailable" })).toBeTruthy();
    });

    it("resolves session names from a loaded session list even when the host list failed", async () => {
      api.failHosts = true;
      prefillAlerts([failed, hostDown]);
      renderPage();
      await waitFor(() => expect(names()).toEqual(["Name unavailable", "Fix login"]), { timeout: 5000 });
    });

    it("says no longer listed only when the loaded list lacks the id", async () => {
      const goneSession: TavroAlert = { ...failed, id: "a-gone", sessionId: "00000000-0000-4000-8000-000000000199" };
      const goneHost: TavroAlert = { ...hostDown, id: "a-gone-host", hostId: "00000000-0000-4000-8000-0000000000b9", at: "2026-10-29T09:00:00.000Z" };
      prefillAlerts([goneSession, goneHost]);
      renderPage();
      await waitFor(() => expect(names()).toEqual(["A session that is no longer listed", "A host that is no longer listed"]), { timeout: 5000 });
    });
  });

  it("shows the empty state when there are no alerts", async () => {
    renderPage();
    const empty = await screen.findByRole("heading", { name: "No alerts" }, { timeout: 5000 });
    expect(within(empty.parentElement as HTMLElement).getByText(/shows up here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  });
});

describe("Shell unread indicator", () => {
  it("shows the unread count in the nav and the tab title", async () => {
    prefillAlerts([
      { id: "u1", kind: "failed", sessionId: S1, hostId: HOST, at: T0, isDemo: true },
      { id: "u2", kind: "completed", sessionId: S2, hostId: HOST, at: "2026-10-29T10:05:00.000Z", isDemo: true },
    ]);
    renderApp(<App />, "/alerts");

    // Top bar and mobile tab bar.
    expect(await screen.findAllByRole("link", { name: "Alerts, 2 unread" }, { timeout: 5000 })).toHaveLength(2);
    expect(document.title).toBe("(2) Tavro");

    fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }, { timeout: 5000 }));
    await waitFor(() => expect(document.title).toBe("Tavro"));
    expect(screen.getAllByRole("link", { name: "Alerts" })).toHaveLength(2);
  });
});
