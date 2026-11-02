// Component tests for the dashboard overview, filters and sorting (spec 3.1,
// 3.3, 3.4) against the demo backend with a manual clock: no simulation ticks
// and no source outage, so the seeded sessions stay put.
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApiContext } from "../api-context.js";
import { UserIdContext } from "../hooks.js";
import { DashboardPage } from "./DashboardPage.js";

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  const { createDemoApi } = await import("@mc/api-client/demo");
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => Promise.resolve(createDemoApi({ tickMs: 0, sourceOutageMs: 0 })),
  };
});

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
let queryClient: QueryClient;

afterEach(() => queryClient.clear());

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  // The demo backend's fixed user; AlertsProvider provides this in the app.
  return api ? <UserIdContext value={DEMO_USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function LocationProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
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
            </Routes>
            <LocationProbe />
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
