// The offline banner and the freshness notes on cards must tell the same story
// (spec 3.1, 14.2: never show cached session states as live). A phone that
// can't refresh blames itself, not a healthy laptop, and a session list that
// stopped refreshing isn't masked by a fresh host list.
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApiContext } from "./api-context.js";
import { UserIdContext } from "./hooks.js";
import { OfflineBanner } from "./offline-banner.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { HostsPage } from "./pages/HostsPage.js";

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  const { createDemoApi } = await import("@mc/api-client/demo");
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    // Manual clock, no source outage, and a laptop that stays on for the whole test.
    createApi: () => Promise.resolve(createDemoApi({ tickMs: 0, sourceOutageMs: 0, onlineMs: 24 * 3_600_000 })),
  };
});

// No AlertsProvider here: its watcher polls sessions and hosts, which these
// tests must control. The dashboard only reads the (empty) alert list.
vi.mock("./alerts-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./alerts-context.js")>()),
  useAlerts: () => [],
}));

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const LAPTOP_SESSION = "Refactor auth middleware";
let queryClient: QueryClient;
let online = true;

function setOnline(next: boolean) {
  online = next;
  act(() => {
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  // TanStack's onlineManager is global: leave it online for the next test.
  setOnline(true);
  delete (window.navigator as { onLine?: boolean }).onLine;
  queryClient.clear();
  vi.useRealTimers();
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  return api ? <UserIdContext value={DEMO_USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function renderShell(route: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <ApiReady>
            <OfflineBanner />
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/hosts" element={<HostsPage />} />
            </Routes>
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const banner = () => (screen.getAllByRole("status").find((r) => r.classList.contains("offline-region"))?.textContent ?? "").trim();
const card = (title: string) => screen.getByRole("heading", { name: title }).closest(".session-card") as HTMLElement;
const fresh = (el: HTMLElement) => (el.querySelector(".fresh")?.textContent ?? "").trim();

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("banner and cards agree", () => {
  it("while offline: cards are stale for the client, and the laptop is never called offline", async () => {
    renderShell("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, { timeout: 5000 });
    expect(banner()).toBe("");
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");

    setOnline(false);
    expect(banner()).toMatch(/^Offline — showing data from/);
    // Straight away, not only after the 90 s threshold.
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now, Stale");

    // Long past the disconnect threshold by the wall clock.
    await advance(10 * 60_000);
    expect(banner()).toMatch(/^Offline — showing data from/);
    const c = card(LAPTOP_SESSION);
    expect(fresh(c)).toBe("Updated 10m ago, Stale");
    expect(c.textContent).not.toContain("· offline");
    expect(c.querySelector(".status")?.textContent).toBe("Needs approval");
    // Only the desktop that really was switched off when last fetched.
    expect(screen.getByRole("button", { name: "Disconnected: 1 session" })).toBeTruthy();

    setOnline(true);
    await advance(1_000);
    expect(banner()).toBe("");
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");
  });

  it("while offline: host cards keep their fetched connectivity and say why they're stale", async () => {
    renderShell("/hosts");
    await screen.findByRole("link", { name: "Demo laptop" }, { timeout: 5000 });
    setOnline(false);
    await advance(10 * 60_000);
    const laptop = screen.getByRole("link", { name: "Demo laptop" }).closest("li") as HTMLElement;
    expect(laptop.textContent).toContain("Online");
    expect(laptop.textContent).not.toContain("Disconnected");
    expect(fresh(laptop)).toBe("Updated 10m ago, Stale");
    expect(screen.getByText(/1 of 2 online/)).toBeTruthy();
    expect(banner()).toMatch(/^Offline — showing data from/);
  });

  it("a fresh host list doesn't hide a session list that stopped refreshing", async () => {
    renderShell("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, { timeout: 5000 });
    // Realtime silently dropped: nothing refreshes the sessions, but hosts keep polling.
    await advance(2 * 60_000);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["hosts"] });
    });
    await advance(5_000);
    expect(banner()).toMatch(/^Not updated since/);
    // The heartbeat is seconds old, but the statuses on screen are two minutes old.
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated 2m ago, Stale");

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["sessions"] });
    });
    expect(banner()).toBe("");
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");
  });
});
