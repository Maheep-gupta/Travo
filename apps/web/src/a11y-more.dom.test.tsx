// Axe coverage for AlertsPage and HostPage (G31, spec 13.3 "tested, not merely
// described"), in the states whose markup differs: the alert empty state, a
// list mixing read and unread rows, an expanded burst group, and a host that
// is online, disconnected or revoked. Same pattern as a11y.dom.test.tsx: demo
// backend, no timers, page scanned once its data has loaded.
import { useEffect, useState, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type AuthUser, type TavroApi } from "@mc/api-client/demo";
import type { TavroAlert } from "@mc/domain";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import { AlertsProvider } from "./alerts-context.js";
import { ApiProvider, useApiContext } from "./api-context.js";
import { AlertsPage } from "./pages/AlertsPage.js";
import { HostPage } from "./pages/HostPage.js";

// Each test builds its own demo backend (so it can revoke a host first); the
// app picks it up through createApi.
const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => {
      if (!backend.api) throw new Error("test backend not set");
      return Promise.resolve(backend.api);
    },
  };
});

// jsdom has no layout or computed colours, so axe cannot judge contrast here;
// the token pairs are checked by contrast.test.ts instead.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const LAPTOP = "00000000-0000-4000-8000-0000000000a1";
const DESKTOP = "00000000-0000-4000-8000-0000000000a2";

let queryClient: QueryClient;
let api: TavroApi;
let user: AuthUser;
beforeEach(async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // tickMs 0: no timer; the simulation only advances when data is read.
  api = createDemoApi({ tickMs: 0, sourceOutageMs: 0 });
  backend.api = api;
  const u = await api.getUser();
  if (!u) throw new Error("demo user missing");
  user = u;
});
afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

/** Like the auth gate in App: the signed-in user boundary once the backend is up. */
function SignedIn({ children }: { children: ReactNode }) {
  const { api: ready } = useApiContext();
  const [current, setCurrent] = useState<AuthUser | null>(null);
  useEffect(() => {
    if (ready) void ready.getUser().then(setCurrent);
  }, [ready]);
  return ready && current ? <AlertsProvider userId={current.id}>{children}</AlertsProvider> : <p>Starting test backend</p>;
}

async function renderLoaded(route: string) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <SignedIn>
            <Routes>
              <Route path="/alerts" element={<AlertsPage />} />
              <Route path="/hosts/:id" element={<HostPage />} />
            </Routes>
          </SignedIn>
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

/** Stores alerts the way AlertsProvider does, before the page mounts. */
function prefill(alerts: TavroAlert[], read: string[]): void {
  const store = new AlertStore(window.localStorage, alertStorageKey("demo", user.id));
  store.add(alerts);
  for (const id of read) store.markRead(id);
}

async function demoSessionIds(): Promise<[string, string]> {
  const ids = (await api.listSessions()).filter((s) => s.host_id === LAPTOP).map((s) => s.id);
  const [a, b] = ids;
  if (!a || !b) throw new Error("demo sessions missing");
  return [a, b];
}

describe("axe: AlertsPage (demo mode)", () => {
  it("empty state has no violations", async () => {
    const { container } = await renderLoaded("/alerts");
    expect(screen.getByRole("heading", { name: "No alerts" })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a list with read and unread alerts has no violations", async () => {
    const [s1, s2] = await demoSessionIds();
    prefill(
      [
        { id: "a-failed", kind: "failed", sessionId: s1, hostId: LAPTOP, at: "2026-11-03T09:00:00.000Z", isDemo: true },
        { id: "a-host", kind: "host_disconnected", sessionId: null, hostId: DESKTOP, at: "2026-11-03T09:05:00.000Z", isDemo: true },
        { id: "a-approval", kind: "approval_required", sessionId: s2, hostId: LAPTOP, at: "2026-11-03T09:10:00.000Z", isDemo: true },
      ],
      ["a-host"],
    );
    const { container } = await renderLoaded("/alerts");
    const rows = screen.getAllByRole("listitem").filter((li) => li.classList.contains("alert-item"));
    expect(rows.map((li) => li.classList.contains("unread"))).toEqual([true, false, true]);
    // Names resolved from live data, so the scan sees the final text.
    expect(screen.getByText("Demo desktop (switched off)")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("an expanded burst group has no violations", async () => {
    const [s1, s2] = await demoSessionIds();
    const done = (id: string, sessionId: string, minute: number): TavroAlert => ({
      id,
      kind: "completed",
      sessionId,
      hostId: LAPTOP,
      at: `2026-11-03T09:0${minute}:00.000Z`,
      isDemo: true,
    });
    prefill([done("d1", s1, 1), done("d2", s2, 2), done("d3", s1, 3)], ["d1"]);
    const { container } = await renderLoaded("/alerts");
    const toggle = screen.getByRole("button", { name: /^Completed · 3 alerts/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const controlled = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(controlled).not.toBeNull();
    expect(within(controlled as HTMLElement).getAllByRole("listitem")).toHaveLength(3);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("axe: HostPage (demo mode)", () => {
  it("an online host has no violations", async () => {
    const { container } = await renderLoaded(`/hosts/${LAPTOP}`);
    expect(screen.getByRole("heading", { level: 1, name: "Demo laptop" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText("Online")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a disconnected host has no violations", async () => {
    const { container } = await renderLoaded(`/hosts/${DESKTOP}`);
    expect(screen.getByRole("heading", { level: 1, name: "Demo desktop (switched off)" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText("Disconnected")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a revoked host has no violations", async () => {
    await api.revokeHost(LAPTOP);
    const { container } = await renderLoaded(`/hosts/${LAPTOP}`);
    expect(screen.getByRole("heading", { level: 1, name: "Demo laptop" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText("Revoked")).toBeTruthy();
    expect(screen.getByText("Access revoked. Pair again to reconnect.")).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});
