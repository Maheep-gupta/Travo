// Component tests for the session detail page (spec 4.3, 18.2) against the
// real demo backend. Covers the trusted state, both untrusted-state
// explanations ("disconnected", "Source not responding"), 404, loading and
// error states, the alerts list's read and dismiss actions (G25), the
// back link's return to a filtered dashboard (G23), plus an axe smoke check.
import { ApiError } from "@mc/api-client/demo";
import { useEffect, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type AuthUser, type TavroApi } from "@mc/api-client/demo";
import type { SessionRow } from "@mc/contracts";
import { dashboardOrigin } from "@mc/domain";
import { AlertsProvider } from "../alerts-context.js";
import { alertStorageKey } from "../alert-store.js";
import { ApiProvider, useApiContext } from "../api-context.js";
import { SessionPage } from "./SessionPage.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

// ApiProvider builds its backend through platform.createApi; hand it the test's demo backend.
vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

// jsdom has no layout or computed colours, so axe cannot judge contrast here.
// Contrast stays a manual / browser check.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

/** Offset added to the demo backend's clock, to move it into a source outage. */
const clock = { offset: 0 };
let queryClient: QueryClient;

beforeEach(() => {
  clock.offset = 0;
  // tickMs 0: no timer; the simulation only advances when data is read. The outage starts
  // 30 s in, well clear of a slow test run, and tests that need it move the clock there.
  backend.api = createDemoApi({ tickMs: 0, now: () => Date.now() + clock.offset, sourceOutageAtMs: 30_000, sourceOutageMs: 60_000 });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

/** Like the app's auth gate: renders children inside the signed-in user's boundary once the backend is up. */
function SignedIn({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    if (api) void api.getUser().then(setUser);
  }, [api]);
  return api && user ? <AlertsProvider userId={user.id}>{children}</AlertsProvider> : <p>Starting test backend</p>;
}

/** The dashboard stand-in; shows the search it was reached with. */
function DashboardRoute() {
  return (
    <>
      <p>Dashboard route</p>
      <output data-testid="search">{useLocation().search}</output>
    </>
  );
}

/** `state`: navigation state on the session's entry, as a dashboard link (or anything else) would leave it. */
function renderSession(id: string, state?: unknown) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[{ pathname: `/sessions/${id}`, state }]}>
          <SignedIn>
            <Routes>
              <Route path="/sessions/:id" element={<SessionPage />} />
              <Route path="/" element={<DashboardRoute />} />
            </Routes>
          </SignedIn>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const demo = () => backend.api as TavroApi;
const UNKNOWN_ID = "00000000-0000-4000-8000-00000000ffff";

/** A live (not ended) session on the demo laptop, and the switched-off host's session. */
async function demoSessions(): Promise<{ live: SessionRow; stale: SessionRow }> {
  const all = await demo().listSessions();
  const live = all.find((s) => s.title !== "Nightly data import" && s.status !== "ended");
  const stale = all.find((s) => s.title === "Nightly data import");
  if (!live || !stale) throw new Error("demo data changed: expected a live and a stale session");
  return { live, stale };
}

const heading = (name: string) => screen.findByRole("heading", { level: 1, name }, { timeout: 5000 });
/** The page header (status, title, explanation). A header inside main is not a landmark, so find it from the h1. */
const detailHead = () => screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
const section = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;

describe("SessionPage", () => {
  it("shows a trusted session's status, reason, host, history and capabilities", async () => {
    const { live } = await demoSessions();
    renderSession(live.id);
    await heading(live.title ?? live.external_id);

    const head = detailHead();
    expect(within(head).getByText("Demo laptop")).toBeTruthy();
    expect(within(head).getByText("Demo")).toBeTruthy();
    // Trusted: no untrusted-state explanation.
    expect(screen.queryByText(/has stopped reporting/)).toBeNull();
    expect(screen.queryByText(/can't read its sessions/)).toBeNull();
    if (live.status_reason) expect(head.textContent).toContain(live.status_reason);

    // Discovery is recorded by the first sync, so history is never empty here.
    expect(await within(section("Status history")).findByText(/^Discovered · /, {}, { timeout: 5000 })).toBeTruthy();

    // Replies are off for the demo provider and that is explained, not hidden.
    expect(screen.getByText("Replies are off for this session")).toBeTruthy();
    const caps = section("What Tavro can do here");
    expect(within(caps).getByText("Read recent messages")).toBeTruthy();
    expect(within(caps).getByText("Reply to the session")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sessions" }).getAttribute("href")).toBe("/");
  });

  it("explains a disconnected host and hides the last reported reason", async () => {
    const { stale } = await demoSessions();
    renderSession(stale.id);
    await heading("Nightly data import");

    const head = detailHead();
    expect(within(head).getByText("Disconnected")).toBeTruthy();
    expect(head.textContent).toContain(
      "Demo desktop (switched off) has stopped reporting, so this session's current state is unknown. Last reported: Working.",
    );
    // The stored reason and summary are not current; they must not read as live.
    expect(screen.queryByText(/last status before the host went offline/)).toBeNull();
    expect(screen.queryByText(/Processing batch 14 of 40/)).toBeNull();
    expect(within(section("Details")).getByText("Disconnected")).toBeTruthy();
  });

  it("explains Source not responding while the host is online but its session source fails", async () => {
    const { live } = await demoSessions();
    // Move the demo clock into the configured source outage; the next read heartbeats with an error.
    clock.offset = 35_000;
    renderSession(live.id);
    await heading(live.title ?? live.external_id);

    const head = detailHead();
    await waitFor(() => expect(within(head).getByText("Source not responding")).toBeTruthy(), { timeout: 5000 });
    expect(head.textContent).toContain("The host can't read its sessions, so this state may be out of date. Last reported:");
    // The host's failure category (the demo simulates a timeout), what to do while it is online, and a way to the host.
    expect(head.textContent).toContain("Reading sessions timed out. The host may be busy or just woke from sleep");
    expect(head.textContent).not.toContain("`");
    const hostLink = within(head).getByRole("link", { name: "View Demo laptop" });
    expect(hostLink.getAttribute("href")).toBe(`/hosts/${live.host_id}`);
    expect(screen.queryByText(/has stopped reporting/)).toBeNull();
    if (live.status_reason) expect(head.textContent).not.toContain(live.status_reason);
    expect(within(section("Details")).getByText("Online")).toBeTruthy();
  });

  it("shows a not-found state with a way back for an unknown id", async () => {
    renderSession(UNKNOWN_ID);
    const title = await screen.findByRole("heading", { name: "Session not found" }, { timeout: 5000 });
    expect(screen.getByRole("heading", { level: 1, name: "Session" })).toBeTruthy();
    const state = title.closest("[role=group]") as HTMLElement;
    expect(within(state).getByText(/belongs to another account/)).toBeTruthy();
    fireEvent.click(within(state).getByRole("link", { name: "Back to sessions" }));
    expect(await screen.findByText("Dashboard route")).toBeTruthy();
  });

  it("shows an announced loading state while sessions load", async () => {
    backend.api = { ...demo(), listSessions: () => new Promise<SessionRow[]>(() => undefined) };
    renderSession(UNKNOWN_ID);
    const loading = await screen.findByText("Loading session…", {}, { timeout: 5000 });
    expect(loading.closest("[role=status]")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Session" })).toBeTruthy();
  });

  it("shows the error with a retry when sessions fail to load", async () => {
    const real = demo();
    const { stale } = await demoSessions();
    let fail = true;
    backend.api = { ...real, listSessions: () => (fail ? Promise.reject(new ApiError("Sessions unavailable", "unavailable")) : real.listSessions()) };
    renderSession(stale.id);
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("Sessions unavailable");

    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await heading("Nightly data import");
  });

  // One test per state; each waits for its final content before scanning.
  it.each(["trusted", "disconnected", "not found"] as const)("has no axe violations in the %s state", async (state) => {
    const { live, stale } = await demoSessions();
    const id = state === "trusted" ? live.id : state === "disconnected" ? stale.id : UNKNOWN_ID;
    const { container } = renderSession(id);
    if (state === "not found") {
      await screen.findByRole("heading", { name: "Session not found" }, { timeout: 5000 });
    } else {
      await screen.findByRole("heading", { level: 2, name: "Status history" }, { timeout: 5000 });
      // The switched-off host's session was never observed changing, so its history is empty.
      const done = state === "trusted" ? /^Discovered · / : "No status changes recorded yet.";
      await within(section("Status history")).findByText(done, {}, { timeout: 5000 });
    }
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("SessionPage freshness, alerts and filters (G4, G7)", () => {
  it("shows the last successful update separately from last activity", async () => {
    const { live, stale } = await demoSessions();
    const view = renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const head = detailHead();
    expect(within(head).getByText("Updated just now")).toBeTruthy();
    expect(head.textContent).not.toContain("Stale");
    expect(within(section("Details")).getByText("Last activity")).toBeTruthy();
    view.unmount();

    renderSession(stale.id);
    await heading("Nightly data import");
    const fresh = detailHead().querySelector(".fresh") as HTMLElement;
    expect(fresh.textContent).toMatch(/^Updated \d+h ago, Stale: Host offline$/);
  });

  it("lists this session's alerts newest first and links to all alerts", async () => {
    const { live, stale } = await demoSessions();
    const user = await demo().getUser();
    if (!user) throw new Error("demo user missing");
    const alert = (id: string, sessionId: string | null, kind: string, at: string, read: boolean) => ({ id, kind, sessionId, hostId: live.host_id, at, isDemo: true, read });
    window.localStorage.setItem(
      alertStorageKey("demo", user.id),
      JSON.stringify([
        alert("a-old", live.id, "waiting_for_input", "2026-11-02T08:00:00.000Z", true),
        alert("a-other", stale.id, "failed", "2026-11-02T09:30:00.000Z", false),
        alert("a-host", null, "host_disconnected", "2026-11-02T09:45:00.000Z", false),
        alert("a-new", live.id, "completed", "2026-11-02T09:00:00.000Z", false),
      ]),
    );
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const alerts = section("Alerts for this session");
    const items = within(alerts).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".ra-kind")?.textContent)).toEqual(["Completed", "Waiting for you"]);
    expect(within(items[0] as HTMLElement).getByText("Unread")).toBeTruthy();
    expect(within(items[1] as HTMLElement).queryByText("Unread")).toBeNull();
    expect(within(alerts).getByRole("link", { name: "All alerts" }).getAttribute("href")).toBe("/alerts");
  });

  it("has an empty state when the session has no alerts", async () => {
    const { live } = await demoSessions();
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const alerts = section("Alerts for this session");
    expect(within(alerts).getByText(/No alerts for this session/)).toBeTruthy();
    expect(within(alerts).getByRole("link", { name: "All alerts" })).toBeTruthy();
  });

  it("links to the dashboard filtered by this session's host and by its provider", async () => {
    const { live } = await demoSessions();
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const filters = screen.getByRole("list", { name: "Find similar sessions" });
    expect(within(filters).getByRole("link", { name: "All sessions on Demo laptop" }).getAttribute("href")).toBe(`/?host=${live.host_id}`);
    expect(within(filters).getByRole("link", { name: "All Demo data sessions" }).getAttribute("href")).toBe(`/?provider=${live.provider}`);
  });
});

describe("SessionPage alert actions (G25)", () => {
  type Seed = { id: string; sessionId: string; kind: string; at: string; read: boolean };
  /** Stores alerts for the demo user before the page opens, as earlier visits would have. */
  async function seedAlerts(alerts: Seed[]): Promise<string> {
    const user = await demo().getUser();
    if (!user) throw new Error("demo user missing");
    const key = alertStorageKey("demo", user.id);
    window.localStorage.setItem(key, JSON.stringify(alerts.map((a) => ({ ...a, hostId: "00000000-0000-4000-8000-0000000000a1", isDemo: true }))));
    return key;
  }
  /** What the store wrote back: id → read. */
  const stored = (key: string) => new Map((JSON.parse(window.localStorage.getItem(key) ?? "[]") as Seed[]).map((a) => [a.id, a.read]));
  const kinds = () => within(section("Alerts for this session")).queryAllByRole("listitem").map((li) => li.querySelector(".ra-kind")?.textContent);

  it("marks read and dismisses single alerts, and marks the rest read, only when asked", async () => {
    const { live, stale } = await demoSessions();
    const key = await seedAlerts([
      { id: "a-new", sessionId: live.id, kind: "completed", at: "2026-11-02T09:00:00.000Z", read: false },
      { id: "a-mid", sessionId: live.id, kind: "waiting_for_input", at: "2026-11-02T08:30:00.000Z", read: false },
      { id: "a-old", sessionId: live.id, kind: "failed", at: "2026-11-02T08:00:00.000Z", read: true },
      { id: "a-other", sessionId: stale.id, kind: "failed", at: "2026-11-02T09:30:00.000Z", read: false },
    ]);
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const alerts = section("Alerts for this session");
    expect(kinds()).toEqual(["Completed", "Waiting for you", "Failed"]);

    // Opening the page marked nothing read.
    expect(within(alerts).getAllByText("Unread")).toHaveLength(2);
    expect(stored(key).get("a-new")).toBe(false);

    // Each action is named by the alert's kind; a read alert has nothing to mark.
    expect(within(alerts).getByRole("button", { name: /^Mark read: Waiting for you, / })).toBeTruthy();
    expect(within(alerts).queryByRole("button", { name: /^Mark read: Failed, / })).toBeNull();
    expect(within(alerts).getByRole("button", { name: /^Dismiss alert: Failed, / })).toBeTruthy();

    fireEvent.click(within(alerts).getByRole("button", { name: /^Mark read: Completed, / }));
    await waitFor(() => expect(within(alerts).getAllByText("Unread")).toHaveLength(1));
    expect(stored(key)).toEqual(new Map([["a-new", true], ["a-mid", false], ["a-old", true], ["a-other", false]]));
    // Focus stays on the row, on its remaining action.
    expect(document.activeElement).toBe(within(alerts).getByRole("button", { name: /^Dismiss alert: Completed, / }));

    fireEvent.click(within(alerts).getByRole("button", { name: /^Dismiss alert: Failed, / }));
    await waitFor(() => expect(kinds()).toEqual(["Completed", "Waiting for you"]));
    expect(stored(key).has("a-old")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Alerts for this session" }));

    // Mark all read covers this session's alerts only.
    fireEvent.click(within(alerts).getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(within(alerts).queryByText("Unread")).toBeNull());
    expect(stored(key)).toEqual(new Map([["a-new", true], ["a-mid", true], ["a-other", false]]));
    expect(within(alerts).queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect(within(alerts).queryByRole("button", { name: /^Mark read: / })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Alerts for this session" }));

    // Dismissing the last ones leaves the empty state.
    fireEvent.click(within(alerts).getByRole("button", { name: /^Dismiss alert: Completed, / }));
    fireEvent.click(within(alerts).getByRole("button", { name: /^Dismiss alert: Waiting for you, / }));
    expect(await within(alerts).findByText(/No alerts for this session/)).toBeTruthy();
    expect(stored(key)).toEqual(new Map([["a-other", false]]));
  });

  it("offers no Mark all read when every alert is read", async () => {
    const { live } = await demoSessions();
    await seedAlerts([{ id: "a-read", sessionId: live.id, kind: "completed", at: "2026-11-02T09:00:00.000Z", read: true }]);
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const alerts = section("Alerts for this session");
    expect(within(alerts).queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect(within(alerts).getByRole("button", { name: /^Dismiss alert: Completed, / })).toBeTruthy();
  });

  it("has no axe violations with alert actions", async () => {
    const { live } = await demoSessions();
    await seedAlerts([{ id: "a-new", sessionId: live.id, kind: "approval_required", at: "2026-11-02T09:00:00.000Z", read: false }]);
    const { container } = renderSession(live.id);
    await heading(live.title ?? live.external_id);
    await within(section("Status history")).findByText(/^Discovered · /, {}, { timeout: 5000 });
    expect(within(section("Alerts for this session")).getByRole("button", { name: /^Mark read: Needs approval, / })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("SessionPage back link (G23)", () => {
  const backLink = () => screen.getByRole("link", { name: "Sessions" });

  /** Opens the session with `state`, checks the link, follows it and returns the dashboard search reached. */
  async function followBack(id: string, title: string, state: unknown, href: string): Promise<string | null> {
    const view = renderSession(id, state);
    await heading(title);
    expect(backLink().getAttribute("href"), JSON.stringify(state)).toBe(href);
    fireEvent.click(backLink());
    await screen.findByText("Dashboard route");
    const reached = screen.getByTestId("search").textContent;
    view.unmount();
    return reached;
  }

  it("returns to the dashboard list it was opened from, filters included, and never anywhere else", async () => {
    const { live } = await demoSessions();
    const title = live.title ?? live.external_id;
    // No earlier in-app entry (a reload or restored tab), so the link navigates to its href.
    expect(await followBack(live.id, title, dashboardOrigin("?state=failed&q=memory"), "/?state=failed&q=memory")).toBe("?state=failed&q=memory");

    // Navigation state is untrusted: anything but the dashboard path with a search falls back to "/".
    for (const forged of [
      { dashboardOrigin: { pathname: "/alerts", search: "" } },
      { dashboardOrigin: { pathname: "//evil.example", search: "" } },
      { dashboardOrigin: { pathname: "/", search: "//evil.example" } },
      "https://evil.example/",
    ]) {
      expect(await followBack(live.id, title, forged, "/"), JSON.stringify(forged)).toBe("");
    }
  });

  /** Somewhere else, then the filtered dashboard, then the session opened from it: as a dashboard card link leaves history. */
  function renderFromDashboard(id: string, search: string) {
    return render(
      <QueryClientProvider client={queryClient}>
        <ApiProvider>
          <MemoryRouter initialEntries={["/elsewhere", `/${search}`, { pathname: `/sessions/${id}`, state: dashboardOrigin(search) }]} initialIndex={2}>
            <SignedIn>
              <NavigationProbe />
              <Routes>
                <Route path="/sessions/:id" element={<SessionPage />} />
                <Route path="/" element={<DashboardRoute />} />
                <Route path="/elsewhere" element={<p>Elsewhere route</p>} />
              </Routes>
            </SignedIn>
          </MemoryRouter>
        </ApiProvider>
      </QueryClientProvider>,
    );
  }

  it("steps back only once on a fast double tap, never past the list", async () => {
    const { live } = await demoSessions();
    renderFromDashboard(live.id, "?state=failed");
    await heading(live.title ?? live.external_id);
    const link = backLink();
    // Both clicks land before React re-renders, as a double tap can.
    act(() => {
      link.click();
      link.click();
    });
    expect(await screen.findByText("Dashboard route")).toBeTruthy();
    expect(screen.queryByText("Elsewhere route")).toBeNull();
    expect(screen.getByTestId("search").textContent).toBe("?state=failed");
    expect(screen.getByTestId("nav").textContent).toBe("POP");
  });

  it("not found: Back to sessions steps back to the list like the back link, instead of pushing it again", async () => {
    renderFromDashboard(UNKNOWN_ID, "?state=failed");
    const title = await screen.findByRole("heading", { name: "Session not found" }, { timeout: 5000 });
    fireEvent.click(within(title.closest("[role=group]") as HTMLElement).getByRole("link", { name: "Back to sessions" }));
    expect(await screen.findByText("Dashboard route")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?state=failed");
    expect(screen.getByTestId("nav").textContent).toBe("POP");
  });

  it("offers the back link when neither the session list nor the history could load", async () => {
    const real = demo();
    backend.api = {
      ...real,
      listSessions: () => Promise.reject(new ApiError("Sessions unavailable", "unavailable")),
      listEvents: () => Promise.reject(new ApiError("History unavailable", "unavailable")),
    };
    renderFromDashboard(UNKNOWN_ID, "?state=failed");
    await screen.findByRole("alert", {}, { timeout: 5000 });
    fireEvent.click(backLink());
    expect(await screen.findByText("Dashboard route")).toBeTruthy();
    expect(screen.getByTestId("nav").textContent).toBe("POP");
  });
});

/** How the current entry was reached: "POP" for a step back, "PUSH" for a new entry. */
function NavigationProbe() {
  return <output data-testid="nav">{useNavigationType()}</output>;
}

describe("SessionPage status history length (mobile review M2)", () => {
  /** `n` recorded changes for `session`, newest first like the API returns them. */
  const history = (session: SessionRow, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: n - i,
      owner_id: session.owner_id,
      host_id: session.host_id,
      session_id: session.id,
      type: "status_changed" as const,
      status: i % 2 ? ("running" as const) : ("waiting_for_input" as const),
      summary: `Change ${n - i}`,
      dedupe_key: `test-${n - i}`,
      is_demo: true,
      occurred_at: new Date(Date.now() - i * 60_000).toISOString(),
    }));
  const items = () => within(section("Status history")).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);

  it("folds a long history to the newest events behind a disclosure, and unfolds it", async () => {
    const { live } = await demoSessions();
    const real = demo();
    backend.api = { ...real, listEvents: () => Promise.resolve(history(live, 20)) };
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    const toggle = await screen.findByRole("button", { name: "Show 12 older events" }, { timeout: 5000 });
    expect(items()).toEqual(Array.from({ length: 8 }, (_, i) => `Change ${20 - i}`));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // It names the list it controls, which stays the same element when it grows.
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(list?.tagName).toBe("OL");
    expect(within(section("Status history")).getByText("20 events")).toBeTruthy();

    fireEvent.click(toggle);
    expect(items()).toHaveLength(20);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show fewer");
    fireEvent.click(toggle);
    expect(items()).toHaveLength(8);
  });

  it("never calls a full page the whole history", async () => {
    const { live } = await demoSessions();
    const real = demo();
    backend.api = { ...real, listEvents: (_id: string, limit?: number) => Promise.resolve(history(live, limit ?? 0)) };
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    // The page asks for STATUS_HISTORY_LIMIT; a full page may be a cut history.
    expect(await within(section("Status history")).findByText("Latest 100 events", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 92 older events" })).toBeTruthy();
  });

  it("shows a short history whole, with no control", async () => {
    const { live } = await demoSessions();
    const real = demo();
    backend.api = { ...real, listEvents: () => Promise.resolve(history(live, 10)) };
    renderSession(live.id);
    await heading(live.title ?? live.external_id);
    expect(await within(section("Status history")).findByText("10 events", {}, { timeout: 5000 })).toBeTruthy();
    expect(items()).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /older event|Show fewer/ })).toBeNull();
  });
});
