// Component tests for the dashboard overview, filters and sorting (spec 3.1,
// 3.3, 3.4) against the demo backend with a manual clock: no simulation ticks
// and no source outage, so the seeded sessions stay put.
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApiContext } from "../api-context.js";
import { AlertsProvider } from "../alerts-context.js";
import { alertStorageKey } from "../alert-store.js";
import { DashboardPage } from "./DashboardPage.js";
import { SessionPage } from "./SessionPage.js";

/** Set by a test to make the host list fail, as a down hosts service would. */
const fail = vi.hoisted(() => ({ hosts: false }));

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  const { ApiError, createDemoApi } = await import("@mc/api-client/demo");
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => {
      const api = createDemoApi({ tickMs: 0, sourceOutageMs: 0 });
      return Promise.resolve({ ...api, listHosts: () => (fail.hosts ? Promise.reject(new ApiError("The hosts service is down.", "unavailable")) : api.listHosts()) });
    },
  };
});

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
let queryClient: QueryClient;

afterEach(() => {
  queryClient.clear();
  window.localStorage.clear();
  fail.hosts = false;
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  // The demo backend's fixed user, inside the same alerts boundary as the app.
  return api ? <AlertsProvider userId={DEMO_USER}>{children}</AlertsProvider> : <p>Starting test backend</p>;
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return (
    <>
      <output data-testid="path">{pathname}</output>
      <output data-testid="search">{search}</output>
    </>
  );
}

/** Stands in for the browser's Back button. */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      History back
    </button>
  );
}

/** Renders the dashboard and waits for the seeded demo sessions. */
async function renderDashboard(route = "/") {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <ApiReady>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/sessions/:id" element={<SessionPage />} />
            </Routes>
            <LocationProbe />
            <BackButton />
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("group", { name: "Filter sessions by state" }, { timeout: 5000 });
}

const search = () => screen.getByTestId("search").textContent;
const cardTitles = () => [...document.querySelectorAll(".session-card .sc-title")].map((h) => h.textContent);
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

// Seeded demo data: six sessions on the online laptop, one on the switched-off desktop.
const ATTENTION_ORDER = [
  "Refactor auth middleware",
  "Write migration for invoices",
  "Investigate memory leak",
  "Nightly data import",
  "Upgrade React Router",
  "Fix flaky checkout e2e test",
  "Draft release notes",
];
const RECENT_ORDER = [
  "Refactor auth middleware",
  "Fix flaky checkout e2e test",
  "Write migration for invoices",
  "Upgrade React Router",
  "Investigate memory leak",
  "Draft release notes",
  "Nightly data import",
];

describe("DashboardPage", () => {
  it("shows the total, Need you and a count for every spec state", async () => {
    await renderDashboard();
    for (const name of [
      "Need you: 3 sessions",
      "All: 7 sessions",
      "Needs approval: 1 session",
      "Waiting for you: 1 session",
      "Failed: 1 session",
      "Working: 2 sessions",
      "Completed: 1 session",
      "Disconnected: 1 session",
      "Source not responding: 0 sessions",
    ]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    // Ended and Unknown have no sessions, so they get no chip.
    expect(within(screen.getByRole("group", { name: "Filter sessions by state" })).getAllByRole("button")).toHaveLength(7);
    expect(pressed("All: 7 sessions")).toBe("true");
    expect(cardTitles()).toEqual(ATTENTION_ORDER);
  });

  it("toggles a state filter through the URL", async () => {
    await renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Failed: 1 session" }));
    await waitFor(() => expect(search()).toBe("?state=failed"));
    expect(pressed("Failed: 1 session")).toBe("true");
    expect(pressed("All: 7 sessions")).toBe("false");
    expect(cardTitles()).toEqual(["Investigate memory leak"]);
    // Announced through the polite live region.
    expect(screen.getByText("Showing 1 of 7 sessions, Failed").getAttribute("aria-live")).toBe("polite");

    // Picking Need you replaces the state filter rather than combining with it.
    fireEvent.click(screen.getByRole("button", { name: "Need you: 3 sessions" }));
    await waitFor(() => expect(search()).toBe("?group=attention"));
    expect(pressed("Failed: 1 session")).toBe("false");
    expect(cardTitles()).toEqual(ATTENTION_ORDER.slice(0, 3));

    fireEvent.click(screen.getByRole("button", { name: "Need you: 3 sessions" }));
    await waitFor(() => expect(search()).toBe(""));
    expect(cardTitles()).toHaveLength(7);
  });

  it("composes host and project filters", async () => {
    await renderDashboard();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "payments-api" } });
    await waitFor(() => expect(search()).toBe("?project=payments-api"));
    expect(cardTitles()).toEqual(["Refactor auth middleware", "Write migration for invoices"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Host" }), { target: { value: "00000000-0000-4000-8000-0000000000a2" } });
    await waitFor(() => expect(search()).toBe("?project=payments-api&host=00000000-0000-4000-8000-0000000000a2"));
    expect(screen.getByRole("heading", { name: "Nothing matches" })).toBeTruthy();
  });

  it("reorders the list when the sort changes, and keeps it in the URL", async () => {
    await renderDashboard();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "recent" } });
    await waitFor(() => expect(search()).toBe("?sort=recent"));
    expect(cardTitles()).toEqual(RECENT_ORDER);
    // A non-default order is one list; the "Needs you" split belongs to attention order.
    expect(screen.queryByRole("heading", { name: "Needs you" })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "attention" } });
    await waitFor(() => expect(search()).toBe(""));
    expect(cardTitles()).toEqual(ATTENTION_ORDER);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  });

  it("ignores invalid URL params", async () => {
    // Unknown state, sort and provider; a malformed host; and a well-formed host id that isn't ours.
    await renderDashboard("/?state=toString&sort=fastest&provider=nope&host=../x");
    expect(cardTitles()).toEqual(ATTENTION_ORDER);
    expect(pressed("All: 7 sessions")).toBe("true");
    expect((screen.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("attention");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("ignores a host id that isn't one of the user's hosts", async () => {
    await renderDashboard("/?host=00000000-0000-4000-8000-00000000ffff");
    expect(cardTitles()).toEqual(ATTENTION_ORDER);
    expect((screen.getByRole("combobox", { name: "Host" }) as HTMLSelectElement).value).toBe("");
  });
});

describe("DashboardPage freshness (G4)", () => {
  const card = (title: string) => [...document.querySelectorAll<HTMLElement>(".session-card")].find((c) => c.querySelector(".sc-title")?.textContent === title) as HTMLElement;

  it("shows when each card's data was last read, separately from last activity, and marks stale data in text", async () => {
    await renderDashboard();
    const live = card("Refactor auth middleware");
    expect(within(live).getByText("Updated just now")).toBeTruthy();
    expect(within(live).queryByText("Stale")).toBeNull();
    // Last activity stays in its own, labelled slot.
    expect(live.querySelector(".sc-time")?.textContent).toMatch(/^Last activity /);

    const offline = card("Nightly data import");
    const fresh = offline.querySelector(".fresh") as HTMLElement;
    expect(fresh.textContent).toMatch(/^Updated \d+h ago, Stale$/);
    expect(within(offline).getByText("Stale")).toBeTruthy();
  });
});

describe("DashboardPage search (G15)", () => {
  const box = () => screen.getByRole("searchbox", { name: "Search sessions" }) as HTMLInputElement;

  it("has a visible label and filters by title or project, case-insensitively, through the URL", async () => {
    await renderDashboard();
    expect(screen.getByText("Search sessions", { selector: "label" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.change(box(), { target: { value: "PAYMENTS" } });
    await waitFor(() => expect(search()).toBe("?q=PAYMENTS"));
    expect(cardTitles()).toEqual(["Refactor auth middleware", "Write migration for invoices"]);
    expect(screen.getByText('Showing 2 of 7 sessions, "PAYMENTS"').getAttribute("aria-live")).toBe("polite");

    // Title match; the box keeps the trailing space while the URL holds the trimmed query.
    fireEvent.change(box(), { target: { value: "memory " } });
    await waitFor(() => expect(search()).toBe("?q=memory"));
    expect(box().value).toBe("memory ");
    expect(cardTitles()).toEqual(["Investigate memory leak"]);
  });

  it("combines with the other filters and names them when nothing matches", async () => {
    await renderDashboard("/?state=failed");
    fireEvent.change(box(), { target: { value: "release" } });
    await waitFor(() => expect(search()).toBe("?state=failed&q=release"));
    expect(screen.getByRole("heading", { name: "Nothing matches" })).toBeTruthy();
    expect(screen.getByText('No sessions match the search "release" with the filter Failed.')).toBeTruthy();

    // Clearing only the search keeps the state filter.
    fireEvent.click(within(document.querySelector(".state") as HTMLElement).getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(search()).toBe("?state=failed"));
    expect(cardTitles()).toEqual(["Investigate memory leak"]);
    expect(box().value).toBe("");
  });

  it("clears with the clear button, and Back brings the search back", async () => {
    await renderDashboard();
    fireEvent.change(box(), { target: { value: "docs" } });
    await waitFor(() => expect(search()).toBe("?q=docs"));
    expect(cardTitles()).toEqual(["Draft release notes"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(search()).toBe(""));
    expect(box().value).toBe("");
    expect(document.activeElement).toBe(box());
    expect(cardTitles()).toHaveLength(7);

    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(search()).toBe("?q=docs"));
    expect(box().value).toBe("docs");
    expect(cardTitles()).toEqual(["Draft release notes"]);
  });

  it("reads a trimmed query from the URL", async () => {
    await renderDashboard("/?q=%20%20storefront%20");
    expect(box().value).toBe("storefront");
    expect(cardTitles()).toEqual(["Fix flaky checkout e2e test"]);
  });

  it("ignores a query with control characters", async () => {
    await renderDashboard("/?q=x%00y");
    expect(box().value).toBe("");
    expect(cardTitles()).toEqual(ATTENTION_ORDER);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});

describe("DashboardPage unread alerts (G14)", () => {
  const card = (title: string) => screen.getByRole("heading", { name: title }).closest(".session-card") as HTMLElement;
  const idOf = (title: string) => (card(title).getAttribute("href") ?? "").replace("/sessions/", "");
  const KEY = alertStorageKey("demo", DEMO_USER);

  /** Writes alerts as another tab would; the store picks them up from the storage event. */
  function storeAlerts(alerts: { id: string; sessionId: string | null; read: boolean }[]) {
    const value = JSON.stringify(
      alerts.map((a) => ({ ...a, kind: a.sessionId ? "failed" : "host_disconnected", hostId: "00000000-0000-4000-8000-0000000000a1", at: "2026-11-02T09:00:00.000Z", isDemo: true })),
    );
    act(() => {
      window.localStorage.setItem(KEY, value);
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: value }));
    });
  }

  it("shows nothing when there are no unread alerts", async () => {
    await renderDashboard();
    expect(screen.queryByText(/unread alert/)).toBeNull();
    expect(document.querySelector(".has-unread")).toBeNull();
  });

  it("summarises unread alerts with a link to Alerts and labels the cards in text", async () => {
    await renderDashboard();
    const failed = idOf("Investigate memory leak");
    const waiting = idOf("Write migration for invoices");
    storeAlerts([
      { id: "a1", sessionId: failed, read: false },
      { id: "a2", sessionId: failed, read: false },
      { id: "a3", sessionId: waiting, read: true },
      { id: "a4", sessionId: null, read: false },
    ]);

    // Host alerts count in the total; read ones don't.
    const link = await screen.findByRole("link", { name: "3 unread alerts" });
    expect(link.getAttribute("href")).toBe("/alerts");
    expect(within(card("Investigate memory leak")).getByText("2 unread alerts")).toBeTruthy();
    expect(card("Investigate memory leak").classList.contains("has-unread")).toBe(true);
    expect(within(card("Write migration for invoices")).queryByText(/unread alert/)).toBeNull();
    expect(document.querySelectorAll(".has-unread")).toHaveLength(1);

    // Marked read elsewhere: everything disappears.
    storeAlerts([
      { id: "a1", sessionId: failed, read: true },
      { id: "a2", sessionId: failed, read: true },
      { id: "a4", sessionId: null, read: true },
    ]);
    await waitFor(() => expect(screen.queryByText(/unread alert/)).toBeNull());
    expect(document.querySelector(".has-unread")).toBeNull();
  });
});

describe("DashboardPage counts while host status is missing (G22)", () => {
  const chip = (state: string) => document.querySelector(`.state-chip.st-${state}`) as HTMLElement;

  it("shows Disconnected and Source not responding as unknown, not 0, and real counts once hosts load", async () => {
    fail.hosts = true;
    await renderDashboard();
    for (const [state, label] of [
      ["disconnected", "Disconnected"],
      ["source_unavailable", "Source not responding"],
    ] as const) {
      expect(screen.getByRole("button", { name: `${label}: unknown while host status isn't loaded` }), label).toBeTruthy();
      expect(chip(state).querySelector("b")?.textContent).toBe("–");
    }
    // The states sessions report themselves keep their counts.
    expect(screen.getByRole("button", { name: "Failed: 1 session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All: 7 sessions" })).toBeTruthy();

    // Recovery: the next host poll brings real counts back.
    fail.hosts = false;
    await act(() => queryClient.refetchQueries({ queryKey: ["hosts"], type: "active" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnected: 1 session" })).toBeTruthy(), { timeout: 5000 });
    expect(chip("disconnected").querySelector("b")?.textContent).toBe("1");
    expect(screen.getByRole("button", { name: "Source not responding: 0 sessions" })).toBeTruthy();
    expect(chip("source_unavailable").querySelector("b")?.textContent).toBe("0");
    expect(document.body.textContent).not.toContain("unknown while host status");
  });
});

describe("DashboardPage to a session and back (G23, G25)", () => {
  const path = () => screen.getByTestId("path").textContent;
  const card = (title: string) => screen.getByRole("heading", { name: title }).closest(".session-card") as HTMLElement;
  const sessionHeading = (title: string) => screen.findByRole("heading", { level: 1, name: title }, { timeout: 5000 });
  const backLink = () => screen.getByRole("link", { name: "Sessions" });

  it("returns to the filtered list it came from, as a step back in history", async () => {
    await renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Failed: 1 session" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "memory" } });
    await waitFor(() => expect(search()).toBe("?state=failed&q=memory"));

    fireEvent.click(card("Investigate memory leak"));
    await sessionHeading("Investigate memory leak");
    // A real href with the filters, so a new tab or a copied link lands on the same list.
    expect(backLink().getAttribute("href")).toBe("/?state=failed&q=memory");

    fireEvent.click(backLink());
    await waitFor(() => expect(path()).toBe("/"));
    expect(search()).toBe("?state=failed&q=memory");
    expect(cardTitles()).toEqual(["Investigate memory leak"]);
    expect(pressed("Failed: 1 session")).toBe("true");

    // It stepped back rather than pushing the list again: Back now leaves the filter, not returns to the session.
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(search()).toBe(""));
    expect(path()).toBe("/");
  });

  it("updates the card's unread label after marking the session's alert read on its page", async () => {
    await renderDashboard();
    const id = (card("Investigate memory leak").getAttribute("href") ?? "").replace("/sessions/", "");
    const key = alertStorageKey("demo", DEMO_USER);
    const value = JSON.stringify([
      { id: "a1", kind: "failed", sessionId: id, hostId: "00000000-0000-4000-8000-0000000000a1", at: "2026-11-02T09:00:00.000Z", isDemo: true, read: false },
    ]);
    act(() => {
      window.localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
    });
    expect(await within(card("Investigate memory leak")).findByText("1 unread alert")).toBeTruthy();

    fireEvent.click(card("Investigate memory leak"));
    await sessionHeading("Investigate memory leak");
    fireEvent.click(screen.getByRole("button", { name: /^Mark read: Failed, / }));

    fireEvent.click(backLink());
    await screen.findByRole("group", { name: "Filter sessions by state" }, { timeout: 5000 });
    expect(within(card("Investigate memory leak")).queryByText(/unread alert/)).toBeNull();
    expect(card("Investigate memory leak").classList.contains("has-unread")).toBe(false);
    expect(screen.queryByRole("link", { name: /unread alert/ })).toBeNull();
  });
});
