// Component tests for the session detail page (spec 4.3, 18.2) against the
// real demo backend. Covers the trusted state, both untrusted-state
// explanations ("disconnected", "Source not responding"), 404, loading and
// error states, plus an axe smoke check.
import { ApiError } from "@mc/api-client/demo";
import { useEffect, useState, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type AuthUser, type TavroApi } from "@mc/api-client/demo";
import type { SessionRow } from "@mc/contracts";
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

function renderSession(id: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[`/sessions/${id}`]}>
          <SignedIn>
            <Routes>
              <Route path="/sessions/:id" element={<SessionPage />} />
              <Route path="/" element={<p>Dashboard route</p>} />
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
    expect(head.textContent).toContain("Demo laptop is online but can't read its sessions right now, so this state may be out of date. Last reported:");
    expect(screen.queryByText(/has stopped reporting/)).toBeNull();
    if (live.status_reason) expect(head.textContent).not.toContain(live.status_reason);
    expect(within(section("Details")).getByText("Online")).toBeTruthy();
  });

  it("shows a not-found state with a way back for an unknown id", async () => {
    renderSession(UNKNOWN_ID);
    const title = await screen.findByRole("heading", { name: "Session not found" }, { timeout: 5000 });
    expect(screen.getByRole("heading", { level: 1, name: "Session" })).toBeTruthy();
    const state = title.closest("[role=status]") as HTMLElement;
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
