// Accessibility smoke tests (spec 13.3, "tested, not merely described") for
// pages whose markup is still changing: render each in demo mode and assert
// axe finds nothing. Detailed behaviour lives in each page's own dom test.
import { useEffect, useState, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type AuthUser } from "@mc/api-client/demo";
import { alertStorageKey } from "./alert-store.js";
import { AlertsProvider } from "./alerts-context.js";
import { ApiProvider, useApiContext } from "./api-context.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { HostsPage } from "./pages/HostsPage.js";
import { OfflineBanner } from "./offline-banner.js";
import { SettingsPage } from "./pages/SettingsPage.js";

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    // tickMs 0: no timer; the simulation only advances when data is read.
    createApi: () => Promise.resolve(createDemoApi({ tickMs: 0 })),
  };
});

// jsdom has no layout or computed colours, so axe cannot judge contrast.
// Contrast is checked manually (and in a real browser once e2e is unblocked).
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => queryClient.clear());

/** Like the auth gate in App: the signed-in user boundary once the backend is up. */
function SignedIn({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    if (api) void api.getUser().then(setUser);
  }, [api]);
  return api && user ? <AlertsProvider userId={user.id}>{children}</AlertsProvider> : <p>Starting test backend</p>;
}

/** Renders a page in demo mode and waits until its data has loaded. */
async function renderLoaded(page: ReactNode, route: string) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <SignedIn>{page}</SignedIn>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1 }, { timeout: 5000 });
  await waitFor(
    () => {
      expect(queryClient.isFetching()).toBe(0);
      expect(screen.queryByText(/^Loading/)).toBeNull();
    },
    { timeout: 5000 },
  );
  return view;
}

describe("axe smoke tests (demo mode)", () => {
  it("the matcher reports a known violation (guards against a vacuous setup)", async () => {
    const { container } = render(
      <main>
        <img src="/x.png" />
        <button type="button" />
      </main>,
    );
    const results = await axe(container);
    expect(results.violations.map((v) => v.id).sort()).toEqual(["button-name", "image-alt"]);
  });

  it("Dashboard has no violations", async () => {
    const { container } = await renderLoaded(<DashboardPage />, "/");
    // Scan the populated page, not an empty or error state (demo data, not markup).
    expect(screen.getAllByText("Nightly data import").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Dashboard with unread alerts and an active search has no violations", async () => {
    const { container } = await renderLoaded(<DashboardPage />, "/?q=import");
    const card = screen.getByRole("heading", { name: "Nightly data import" }).closest("a") as HTMLElement;
    // Every demo backend has the same fixed user.
    const user = await createDemoApi({ tickMs: 0 }).getUser();
    if (!user) throw new Error("demo user missing");
    const key = alertStorageKey("demo", user.id);
    const sessionId = (card.getAttribute("href") ?? "").replace("/sessions/", "");
    const value = JSON.stringify([{ id: "a1", kind: "failed", sessionId, hostId: "00000000-0000-4000-8000-0000000000a2", at: "2026-11-02T09:00:00.000Z", isDemo: true, read: false }]);
    act(() => {
      window.localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
    });
    await screen.findByRole("link", { name: "1 unread alert" });
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
    window.localStorage.removeItem(key);
  });

  it("Dashboard with a search that matches nothing has no violations", async () => {
    const { container } = await renderLoaded(<DashboardPage />, "/?q=zzzz&state=failed");
    expect(screen.getByText('No sessions match the search "zzzz" with the filter Failed.')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Hosts has no violations", async () => {
    const { container } = await renderLoaded(<HostsPage />, "/hosts");
    expect(screen.getAllByText("Demo desktop (switched off)").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Settings (all sections) has no violations", async () => {
    const { container } = await renderLoaded(<SettingsPage />, "/settings");
    for (const name of ["Account", "Privacy & data", "Integrations", "Application"]) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  describe("offline banner", () => {
    let online = true;
    const setOnline = (next: boolean) => {
      online = next;
      act(() => {
        window.dispatchEvent(new Event(next ? "online" : "offline"));
      });
    };
    beforeEach(() => {
      online = true;
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
    });
    afterEach(() => {
      // TanStack's onlineManager is global: leave it online for later tests.
      setOnline(true);
      delete (window.navigator as { onLine?: boolean }).onLine;
    });

    it("Dashboard with the offline banner showing has no violations", async () => {
      const { container } = await renderLoaded(
        <>
          <OfflineBanner />
          <DashboardPage />
        </>,
        "/",
      );
      setOnline(false);
      expect(screen.getByText(/^Offline — showing data from/)).toBeTruthy();
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
