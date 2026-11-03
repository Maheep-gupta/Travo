// An incomplete session list (G28): every page that counts or looks up
// sessions from it says when only the newest sessions are shown, or when rows
// couldn't be read, and only once that list is on screen. A session the list
// left out is looked up on its own instead of being called missing. Counts
// only: nothing from a dropped row is ever shown.
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoApi, type TavroApi } from "@mc/api-client/demo";
import type { HostRow, SessionRow } from "@mc/contracts";
import type { SessionListGaps } from "@mc/domain";
import { ApiProvider, useApiContext } from "./api-context.js";
import { TruncatedNotice } from "./components.js";
import { UserIdContext } from "./hooks.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { HostPage } from "./pages/HostPage.js";
import { HostsPage } from "./pages/HostsPage.js";
import { SessionPage } from "./pages/SessionPage.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

// No AlertsProvider: its watcher would fetch the list too. The pages only read the (empty) alert
// list; the session page's alert actions get a real, empty store that nothing here writes to.
vi.mock("./alerts-context.js", async (importOriginal) => {
  const { AlertStore } = await import("./alert-store.js");
  const store = new AlertStore(window.localStorage, "session-list-gaps-test-alerts");
  return {
    ...(await importOriginal<typeof import("./alerts-context.js")>()),
    useAlerts: () => [],
    useAlertStore: () => store,
  };
});

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const CAPPED = "Showing the 500 most recent sessions; counts cover only these.";
const ONE_DROPPED = "1 session couldn't be read and isn't shown.";
const LAPTOP_SESSION = "Refactor auth middleware";

let queryClient: QueryClient;
let demo: TavroApi;

/**
 * The demo backend, whose list reports `next` as its gaps once it answers (or
 * never answers). `omit`: sessions the list leaves out, as if past the cut or
 * unreadable; `getSession` still finds them.
 */
function backendReporting(next: SessionListGaps, opts: { hang?: boolean; omit?: (s: SessionRow) => boolean } = {}): TavroApi {
  let gaps: SessionListGaps | null = null;
  const listeners = new Set<() => void>();
  return {
    ...demo,
    sessionList: {
      gaps: () => gaps,
      onChange(cb) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    },
    async listSessions(): Promise<SessionRow[]> {
      if (opts.hang) {
        // Gaps from some earlier list, while this one never loads.
        gaps = next;
        for (const l of listeners) l();
        return new Promise<SessionRow[]>(() => undefined);
      }
      const rows = (await demo.listSessions()).filter((s) => !opts.omit?.(s));
      gaps = next;
      for (const l of listeners) l();
      return rows;
    },
  };
}

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  return api ? <UserIdContext value={DEMO_USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function renderAt(route: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <ApiReady>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/hosts" element={<HostsPage />} />
              <Route path="/hosts/:id" element={<HostPage />} />
              <Route path="/sessions/:id" element={<SessionPage />} />
            </Routes>
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const renderDashboard = () => renderAt("/");
const T = { timeout: 5000 };
const sessionsShown = () => waitFor(() => expect(screen.getByRole("heading", { name: LAPTOP_SESSION })).toBeTruthy(), T);
/** The session page's header (status, title, host). A header inside main is not a landmark, so find it from the h1. */
const detailHead = () => screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;

async function laptopSession(): Promise<SessionRow> {
  const s = (await demo.listSessions()).find((x) => x.title === LAPTOP_SESSION);
  if (!s) throw new Error("demo data changed");
  return s;
}

beforeEach(() => {
  // Manual clock, no source outage, and a laptop that stays on for the whole test.
  demo = createDemoApi({ tickMs: 0, sourceOutageMs: 0, onlineMs: 24 * 3_600_000 });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

describe("TruncatedNotice", () => {
  it("renders nothing for a complete list, and one sentence per gap otherwise", () => {
    const { container, rerender } = render(<TruncatedNotice truncated={false} dropped={0} />);
    expect(container.textContent).toBe("");
    rerender(<TruncatedNotice truncated dropped={0} />);
    expect(container.textContent).toBe(CAPPED);
    // With unreadable rows the cut list may hold fewer than 500, so no exact number.
    rerender(<TruncatedNotice truncated dropped={2} />);
    expect(container.textContent).toContain("Showing the newest sessions (up to 500); counts cover only these.");
    expect(container.textContent).not.toContain(CAPPED);
    expect(container.textContent).toContain("2 sessions couldn't be read and aren't shown.");
  });
});

describe("Dashboard with an incomplete session list", () => {
  it("says when only the newest sessions are shown", async () => {
    backend.api = backendReporting({ truncated: true, dropped: 0 });
    renderDashboard();
    await sessionsShown();
    expect(await screen.findByText(CAPPED)).toBeTruthy();
    expect(screen.queryByText(ONE_DROPPED)).toBeNull();
  });

  it("says a row couldn't be read, without anything from the row", async () => {
    backend.api = backendReporting({ truncated: false, dropped: 1 });
    renderDashboard();
    await sessionsShown();
    expect(await screen.findByText(ONE_DROPPED)).toBeTruthy();
    expect(screen.queryByText(CAPPED)).toBeNull();
  });

  it("says nothing for a complete list", async () => {
    backend.api = backendReporting({ truncated: false, dropped: 0 });
    renderDashboard();
    await sessionsShown();
    expect(screen.queryByText(CAPPED)).toBeNull();
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
  });

  it("says nothing until the session list is on screen", async () => {
    backend.api = backendReporting({ truncated: true, dropped: 1 }, { hang: true });
    renderDashboard();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy(), T);
    expect(screen.queryByText(CAPPED)).toBeNull();
    expect(screen.queryByText(ONE_DROPPED)).toBeNull();
  });
});

describe("Hosts pages with an incomplete session list (QA M2)", () => {
  it("says on the hosts list that its session counts cover only the sessions loaded", async () => {
    backend.api = backendReporting({ truncated: true, dropped: 0 });
    renderAt("/hosts");
    await screen.findByRole("heading", { name: "Paired hosts" }, T);
    expect(await screen.findByText(CAPPED, {}, T)).toBeTruthy();
  });

  it("says nothing on the hosts list for a complete list", async () => {
    backend.api = backendReporting({ truncated: false, dropped: 0 });
    renderAt("/hosts");
    await screen.findByRole("heading", { name: "Paired hosts" }, T);
    // Wait for the session counts, so the gaps would have been reported by now.
    await waitFor(() => expect(screen.queryAllByText(/Loading/).length).toBe(0), T);
    expect(screen.queryByText(CAPPED)).toBeNull();
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
  });

  it("says a host's own sessions may be incomplete, and never that it has none", async () => {
    const { host_id } = await laptopSession();
    // Every session left out of the list: the host's section would otherwise claim it has none.
    backend.api = backendReporting({ truncated: false, dropped: 1 }, { omit: () => true });
    renderAt(`/hosts/${host_id}`);
    await screen.findByRole("heading", { level: 1, name: "Demo laptop" }, T);
    expect(await screen.findByText(ONE_DROPPED, {}, T)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No sessions from this host among those loaded" }, T)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No sessions from this host" })).toBeNull();
  });
});

describe("Session page for a session the incomplete list left out (QA M1)", () => {
  it("looks it up on its own and shows it, judged by its host like any listed session", async () => {
    const target = await laptopSession();
    backend.api = backendReporting({ truncated: true, dropped: 0 }, { omit: (s) => s.id === target.id });
    renderAt(`/sessions/${target.id}`);
    await screen.findByRole("heading", { level: 1, name: LAPTOP_SESSION }, T);
    expect(within(detailHead()).getByText("Demo laptop")).toBeTruthy();
    expect(screen.queryByText("Session not found")).toBeNull();
  });

  it("shows it untrusted when its host isn't in the host list", async () => {
    const target = await laptopSession();
    const api = backendReporting({ truncated: true, dropped: 0 }, { omit: (s) => s.id === target.id });
    backend.api = { ...api, listHosts: async (): Promise<HostRow[]> => (await demo.listHosts()).filter((h) => h.id !== target.host_id) };
    renderAt(`/sessions/${target.id}`);
    await screen.findByRole("heading", { level: 1, name: LAPTOP_SESSION }, T);
    const head = detailHead();
    expect(within(head).getByText("Unknown host")).toBeTruthy();
    expect(within(head).getByText("Disconnected")).toBeTruthy();
    // Its last reported reason is not vouched for.
    if (target.status_reason) expect(head.textContent).not.toContain(target.status_reason);
  });

  it("says honestly that it wasn't found among the sessions loaded, without blaming another account", async () => {
    const target = await laptopSession();
    backend.api = { ...backendReporting({ truncated: false, dropped: 1 }, { omit: (s) => s.id === target.id }), getSession: () => Promise.resolve(null) };
    renderAt(`/sessions/${target.id}`);
    const title = await screen.findByRole("heading", { name: "Session not found" }, T);
    const state = title.closest("[role=status]") as HTMLElement;
    expect(state.textContent).toContain("Tavro couldn't find this session in the sessions it loaded");
    expect(state.textContent).not.toMatch(/another account/);
    expect(within(state).getByRole("link", { name: "Back to sessions" })).toBeTruthy();
  });

  it("keeps the usual not-found copy when the list is complete, without a second lookup", async () => {
    const target = await laptopSession();
    const getSession = vi.fn((id: string) => demo.getSession(id));
    backend.api = { ...backendReporting({ truncated: false, dropped: 0 }, { omit: (s) => s.id === target.id }), getSession };
    renderAt(`/sessions/${target.id}`);
    const title = await screen.findByRole("heading", { name: "Session not found" }, T);
    expect((title.closest("[role=status]") as HTMLElement).textContent).toMatch(/belongs to another account/);
    expect(getSession).not.toHaveBeenCalled();
  });
});
