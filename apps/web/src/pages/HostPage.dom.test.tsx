// Component tests for host detail (spec 6.3) and the Hosts list summary
// (spec 6.1) against the demo backend with a manual clock.
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApiContext } from "../api-context.js";
import { UserIdContext } from "../hooks.js";
import { HostPage } from "./HostPage.js";
import { HostsPage } from "./HostsPage.js";

const demo = vi.hoisted(() => ({ sourceOutage: false }));

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  const { createDemoApi } = await import("@mc/api-client/demo");
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    // With an outage from t=0 the laptop heartbeats but never reports a session.
    createApi: () =>
      Promise.resolve(createDemoApi(demo.sourceOutage ? { tickMs: 0, sourceOutageAtMs: 0, sourceOutageMs: 60_000 } : { tickMs: 0, sourceOutageMs: 0 })),
  };
});

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const LAPTOP = "00000000-0000-4000-8000-0000000000a1";
const DESKTOP = "00000000-0000-4000-8000-0000000000a2";
let queryClient: QueryClient;

afterEach(() => {
  queryClient.clear();
  demo.sourceOutage = false;
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  // The demo backend's fixed user; AlertsProvider provides this in the app.
  return api ? <UserIdContext value={DEMO_USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function renderAt(route: string) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <ApiReady>
            <Routes>
              <Route path="/hosts" element={<HostsPage />} />
              <Route path="/hosts/:id" element={<HostPage />} />
            </Routes>
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const sessionLinks = () => screen.getAllByRole("link").filter((l) => l.classList.contains("session-card"));

describe("HostPage", () => {
  it("shows identity, health and the host's sessions", async () => {
    const { container } = renderAt(`/hosts/${LAPTOP}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Demo laptop" }, { timeout: 5000 })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText("Online")).toBeTruthy();
    expect(screen.getByText("Reading sessions normally")).toBeTruthy();
    const identity = screen.getByRole("region", { name: "Identity" });
    expect(within(identity).getByText("simulated")).toBeTruthy();
    expect(within(identity).getByText("demo")).toBeTruthy();
    expect(within(identity).getByText(/\(24h ago\)/)).toBeTruthy();

    const links = await screen.findAllByRole("link", { name: /Demo laptop/ });
    const cards = sessionLinks();
    expect(cards).toHaveLength(6);
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const card of cards) expect(card.getAttribute("href")).toMatch(/^\/sessions\/[0-9a-f-]{36}$/);
    expect(screen.getByRole("link", { name: "Filter the dashboard to this host" }).getAttribute("href")).toBe(`/?host=${LAPTOP}`);
    // Read-only: revoking stays on the Hosts list.
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    // No absolute paths anywhere on the page.
    expect(container.textContent).not.toMatch(/[A-Za-z]:\\|\/(Users|home)\//);
  });

  it("shows a switched-off host as disconnected with its last session", async () => {
    renderAt(`/hosts/${DESKTOP}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Demo desktop (switched off)" }, { timeout: 5000 })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText("Disconnected")).toBeTruthy();
    expect(screen.getByText("Unknown while the host isn't reporting")).toBeTruthy();
    expect((await screen.findAllByRole("link")).filter((l) => l.classList.contains("session-card")).map((l) => l.querySelector("h3")?.textContent)).toEqual([
      "Nightly data import",
    ]);
  });

  it("says when the host can't read its sessions", async () => {
    demo.sourceOutage = true;
    renderAt(`/hosts/${LAPTOP}`);
    expect(await screen.findByText(/Can't read its sessions since just now\./, {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No sessions from this host" })).toBeTruthy();
  });

  it("shows a not-found state for unknown and malformed ids", async () => {
    for (const id of ["00000000-0000-4000-8000-00000000ffff", "not-a-host"]) {
      const view = renderAt(`/hosts/${id}`);
      expect(await screen.findByRole("heading", { name: "Host not found" }, { timeout: 5000 })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Back to hosts" }).getAttribute("href")).toBe("/hosts");
      view.unmount();
      queryClient.clear();
    }
  });
});

describe("HostsPage summary", () => {
  it("shows each host's session count and last activity, and links to its detail page", async () => {
    renderAt("/hosts");
    const laptop = await screen.findByRole("link", { name: "Demo laptop" }, { timeout: 5000 });
    expect(laptop.getAttribute("href")).toBe(`/hosts/${LAPTOP}`);
    expect(screen.getByRole("link", { name: "Demo desktop (switched off)" }).getAttribute("href")).toBe(`/hosts/${DESKTOP}`);
    expect(await screen.findByText("6 · last active just now")).toBeTruthy();
    expect(screen.getByText("1 · last active 3h ago")).toBeTruthy();
  });
});
