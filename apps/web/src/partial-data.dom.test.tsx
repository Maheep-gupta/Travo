// Partial data (spec 3.5, Part 16; G13): when one query fails and another
// succeeds, every page keeps what loaded, says exactly what is missing, never
// presents host-derived status as trusted without the host list, and recovers
// on its own once the failing query succeeds. Covers first loads and failed
// refreshes, the dashboard's honest headline (spec 3.1), and its loading and
// empty states. Errors stay sanitized: only ApiError messages are shown.
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { ApiError, createDemoApi, type TavroApi } from "@mc/api-client/demo";
import type { HostRow, SessionRow } from "@mc/contracts";
import { LivePill } from "./App.js";
import { ApiProvider, useApiContext } from "./api-context.js";
import { UserIdContext } from "./hooks.js";
import { OfflineBanner } from "./offline-banner.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { HostPage } from "./pages/HostPage.js";
import { HostsPage } from "./pages/HostsPage.js";
import { SessionPage } from "./pages/SessionPage.js";

// jsdom has no layout or computed colours, so contrast stays a manual check.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

// No AlertsProvider: its watcher polls sessions and hosts, which these tests
// must control. The pages only read the (empty) alert list; the session page's
// alert actions get a real, empty store that nothing here writes to.
vi.mock("./alerts-context.js", async (importOriginal) => {
  const { AlertStore } = await import("./alert-store.js");
  const store = new AlertStore(window.localStorage, "partial-data-test-alerts");
  return {
    ...(await importOriginal<typeof import("./alerts-context.js")>()),
    useAlerts: () => [],
    useAlertStore: () => store,
  };
});

// Each test renders the app shell against the demo backend and walks a failure and its recovery;
// the first one also pays for loading every page module.
vi.setConfig({ testTimeout: 20_000 });

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const LAPTOP = "00000000-0000-4000-8000-0000000000a1";
const LAPTOP_SESSION = "Refactor auth middleware";

type Source = "sessions" | "hosts" | "events" | "messages";
/** Per source: false = answers, "api" = a user-facing ApiError, "raw" = an internal error that must never be shown. */
const fail: Record<Source, false | "api" | "raw"> = { sessions: false, hosts: false, events: false, messages: false };
let demo: TavroApi;
let hostsOverride: ((hosts: HostRow[]) => HostRow[]) | null;
let sessionsOverride: ((sessions: SessionRow[]) => SessionRow[]) | null;
let hangSessions: boolean;
let queryClient: QueryClient;
let online: boolean;

function gate<T>(source: Source, run: () => Promise<T>): Promise<T> {
  const mode = fail[source];
  if (mode === "api") return Promise.reject(new ApiError(`The ${source} service is down.`, "unavailable"));
  if (mode === "raw") return Promise.reject(new Error(`column ${source}.owner_id leaked`));
  return run();
}

function scriptedBackend(): TavroApi {
  return {
    ...demo,
    listSessions: () =>
      hangSessions ? new Promise<SessionRow[]>(() => undefined) : gate("sessions", async () => (sessionsOverride ?? ((s) => s))(await demo.listSessions())),
    listHosts: () => gate("hosts", async () => (hostsOverride ?? ((h) => h))(await demo.listHosts())),
    listEvents: (id, limit) => gate("events", () => demo.listEvents(id, limit)),
    listMessages: (id, limit) => gate("messages", () => demo.listMessages(id, limit)),
  };
}

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
  for (const k of Object.keys(fail) as Source[]) fail[k] = false;
  hostsOverride = null;
  sessionsOverride = null;
  hangSessions = false;
  // Manual clock, no source outage, and a laptop that stays on for the whole test.
  demo = createDemoApi({ tickMs: 0, sourceOutageMs: 0, onlineMs: 24 * 3_600_000 });
  backend.api = scriptedBackend();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  // TanStack's onlineManager is global: leave it online for the next test.
  setOnline(true);
  delete (window.navigator as { onLine?: boolean }).onLine;
  queryClient.clear();
  backend.api = null;
  vi.useRealTimers();
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  return api ? <UserIdContext value={DEMO_USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function LocationProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderAt(route: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={[route]}>
          <ApiReady>
            <LivePill />
            <OfflineBanner />
            <LocationProbe />
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

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** What the app's 30 s poll does: refetch one list (or both). */
async function poll(...keys: ("sessions" | "hosts")[]) {
  await act(async () => {
    for (const key of keys) await queryClient.refetchQueries({ queryKey: [key] });
  });
}

const T = { timeout: 5000 };
const banner = () => (screen.getAllByRole("status").find((r) => r.classList.contains("offline-region"))?.textContent ?? "").trim();
const h1 = () => screen.getByRole("heading", { level: 1 }).textContent;
/** The top bar's backend indicator: its visible text. */
const pill = () => screen.getByRole("link", { name: /\. Open settings$/ }).textContent;
const card = (title: string) => screen.getByRole("heading", { name: title }).closest(".session-card") as HTMLElement;
const fresh = (el: HTMLElement) => (el.querySelector(".fresh")?.textContent ?? "").trim();
const alerts = () => screen.queryAllByRole("alert");
/** The one alert that mentions `text`. */
const alertWith = (text: string | RegExp) => {
  const found = alerts().filter((a) => (typeof text === "string" ? a.textContent?.includes(text) : text.test(a.textContent ?? "")));
  if (found.length !== 1) throw new Error(`expected one alert with ${String(text)}, found ${found.length}`);
  return found[0] as HTMLElement;
};
const findAlertWith = (text: string | RegExp) => waitFor(() => alertWith(text), T);
const refreshNotice = () => screen.queryAllByRole("status").find((r) => r.textContent?.startsWith("Couldn't refresh")) ?? null;
const section = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
const liveSessionId = async () => {
  const s = (await demo.listSessions()).find((x) => x.title === LAPTOP_SESSION);
  if (!s) throw new Error("demo data changed");
  return s.id;
};

describe("dashboard: sessions loaded, hosts failed", () => {
  it("on first load shows the sessions as last reported, never trusted, and recovers on the next poll", async () => {
    fail.hosts = "api";
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);

    const notice = alertWith("Host status couldn't be loaded.");
    expect(notice.textContent).toContain("The hosts service is down.");
    // Last reported status, stale, with no claim either way about the host.
    const c = card(LAPTOP_SESSION);
    expect(c.querySelector(".status")?.textContent).toBe("Needs approval");
    expect(fresh(c)).toMatch(/, Stale$/);
    expect(c.textContent).toContain("Host not loaded");
    expect(c.textContent).not.toContain("· offline");
    // Without hosts nothing can be counted as disconnected: unknown, not 0 (G22).
    expect(screen.getByRole("button", { name: "Disconnected: unknown while host status isn't loaded" })).toBeTruthy();
    expect(h1()).toBe("Statuses can't be confirmed — last reported: 3 sessions need you.");
    // The banner sees nothing wrong yet, but the pill agrees with the page, not with "Connected".
    expect(banner()).toBe("");
    expect(pill()).toBe("Incomplete");

    fail.hosts = false;
    await poll("hosts");
    expect(alerts()).toHaveLength(0);
    expect(card(LAPTOP_SESSION).textContent).toContain("Demo laptop");
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");
    expect(screen.getByRole("button", { name: "Disconnected: 1 session" })).toBeTruthy();
    expect(h1()).toBe("3 sessions need you.");
    expect(pill()).toBe("Supabase");
  });

  it("after a failed refresh keeps the cards, says from when, marks them stale and recovers", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    fail.hosts = "api";
    await poll("hosts");

    expect(card(LAPTOP_SESSION).textContent).toContain("Demo laptop");
    expect(refreshNotice()?.textContent).toMatch(/^Couldn't refresh host status — showing data from .+\./);
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now, Stale");
    expect(h1()).toBe("Can't confirm right now — last known: 3 sessions need you.");
    expect(screen.getByText(/^Counts as of /)).toBeTruthy();
    // Well inside the banner's 90 s threshold, the pill already says what the page says.
    expect(banner()).toBe("");
    expect(pill()).toBe("Not refreshing");

    fail.hosts = false;
    fireEvent.click(within(refreshNotice() as HTMLElement).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(refreshNotice()).toBeNull(), T);
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");
    expect(screen.queryByText(/^Counts as of /)).toBeNull();
    expect(h1()).toBe("3 sessions need you.");
    expect(pill()).toBe("Supabase");
  });

  it("has no axe violations with host status missing, then with a failed refresh", async () => {
    fail.hosts = "api";
    const { container } = renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(await axe(container)).toHaveNoViolations();
    fail.hosts = false;
    await poll("hosts");
    fail.sessions = "api";
    await poll("sessions");
    expect(refreshNotice()).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps a host filter from the URL while the host list can't load", async () => {
    fail.hosts = "api";
    renderAt(`/?host=${LAPTOP}`);
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    const hostSelect = () => screen.getByRole("combobox", { name: "Host" }) as HTMLSelectElement;
    expect(hostSelect().value).toBe(LAPTOP);
    expect(hostSelect().selectedOptions[0]?.textContent).toBe("Host (not loaded)");
    expect(document.querySelector(".active-filter")?.textContent).toContain("Host (not loaded)");
    // Still filtering: the session on the other host is not shown.
    expect(screen.queryByRole("heading", { name: "Nightly data import" })).toBeNull();

    // Another filter change keeps it in the URL.
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "recent" } });
    await waitFor(() => expect(screen.getByTestId("search").textContent).toContain(`host=${LAPTOP}`), T);

    fail.hosts = false;
    await poll("hosts");
    expect(hostSelect().value).toBe(LAPTOP);
    expect(hostSelect().selectedOptions[0]?.textContent).toBe("Demo laptop");
  });

  it("filtered to a state only the host list can tell, says it can't tell rather than that nothing matches, and retries", async () => {
    fail.hosts = "api";
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    fireEvent.click(screen.getByRole("button", { name: "Disconnected: unknown while host status isn't loaded" }));

    const empty = await screen.findByRole("heading", { name: "Can't tell right now" }, T);
    const state = empty.closest("[role=status]") as HTMLElement;
    expect(state.textContent).toContain("Host status isn't loaded, so Tavro can't tell which sessions are disconnected right now.");
    expect(screen.queryByRole("heading", { name: "Nothing matches" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/No sessions match/);

    // Its retry loads the host list, and the filter then shows what it really holds.
    fail.hosts = false;
    fireEvent.click(within(state).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Nightly data import" }, T);
    expect(screen.queryByRole("heading", { name: "Can't tell right now" })).toBeNull();
  });

  it("never shows an internal error message", async () => {
    fail.hosts = "raw";
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    const notice = alertWith("Host status couldn't be loaded.");
    expect(notice.textContent).toContain("Something went wrong. Try again in a moment.");
    expect(document.body.textContent).not.toContain("owner_id");
  });
});

describe("dashboard: hosts loaded, sessions failed", () => {
  it("on first load names what is missing, shows the hosts, and retries", async () => {
    fail.sessions = "api";
    renderAt("/");
    const notice = await findAlertWith("Sessions couldn't be loaded.");
    expect(notice.textContent).toContain("The sessions service is down.");
    await waitFor(() => expect(notice.textContent).toContain("Your hosts loaded: 1 of 2 online."), T);
    expect(within(notice).getByRole("link", { name: "View hosts" }).getAttribute("href")).toBe("/hosts");
    expect(document.querySelectorAll(".session-card")).toHaveLength(0);

    fail.sessions = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(alerts()).toHaveLength(0);
  });

  it("after a failed refresh keeps the cards and recovers on the next poll", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    fail.sessions = "api";
    await poll("sessions");
    expect(refreshNotice()?.textContent).toMatch(/^Couldn't refresh sessions — showing data from /);
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now, Stale");
    expect(alerts()).toHaveLength(0);

    fail.sessions = false;
    await poll("sessions");
    expect(refreshNotice()).toBeNull();
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");
  });
});

describe("dashboard: complete failure, loading and empty states", () => {
  it("shows one full error when both lists fail, and recovers on retry", async () => {
    fail.sessions = "api";
    fail.hosts = "api";
    renderAt("/");
    const error = await findAlertWith("The sessions service is down.");
    expect(error.textContent).not.toContain("couldn't be loaded");
    expect(alerts()).toHaveLength(1);

    fail.sessions = false;
    fail.hosts = false;
    fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
  });

  it("announces loading while the session list loads", async () => {
    hangSessions = true;
    renderAt("/");
    const loading = await screen.findByText("Loading sessions…", {}, T);
    expect(loading.closest("[role=status]")).toBeTruthy();
  });

  it("tells no hosts paired apart from paired hosts without sessions", async () => {
    sessionsOverride = () => [];
    hostsOverride = () => [];
    const { unmount } = renderAt("/");
    await screen.findByRole("heading", { name: "No hosts paired yet" }, T);
    expect(screen.getByRole("link", { name: "Pair a host" }).getAttribute("href")).toBe("/hosts");
    unmount();
    queryClient.clear();

    hostsOverride = null;
    renderAt("/");
    await screen.findByRole("heading", { level: 2, name: "No sessions yet" }, T);
    expect(screen.getByText(/^1 of 2 paired hosts are online\./)).toBeTruthy();
  });
});

describe("dashboard headline (spec 3.1)", () => {
  it("is the usual copy while current with a trusted host", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(h1()).toBe("3 sessions need you.");
    expect(screen.queryByText(/^Counts as of /)).toBeNull();
  });

  it("can't confirm anything while offline", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    setOnline(false);
    expect(h1()).toBe("Can't confirm right now — last known: 3 sessions need you.");
    expect(screen.getByText(/^Counts as of /)).toBeTruthy();
    setOnline(true);
    await advance(1_000);
    expect(h1()).toBe("3 sessions need you.");
  });

  it("can't confirm anything once the data is over 90 s old", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    await advance(2 * 60_000);
    expect(banner()).toMatch(/^Not updated since/);
    expect(h1()).toBe("Can't confirm right now — last known: 3 sessions need you.");
    expect(screen.getByText(/^Counts as of /)).toBeTruthy();
  });

  it("doesn't say all clear while a session sits on an offline host", async () => {
    // Nothing needs the user on the online laptop; the other host is offline.
    sessionsOverride = (sessions) => sessions.map((s) => ({ ...s, status: "running" }));
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(screen.getByRole("button", { name: "Disconnected: 1 session" })).toBeTruthy();
    expect(h1()).toBe("Nothing confirmed needs you — 1 session can't be confirmed.");
  });

  it("says statuses can't be confirmed when every host is offline", async () => {
    const longAgo = () => new Date(Date.now() - 3_600_000).toISOString();
    hostsOverride = (hosts) => hosts.map((h) => ({ ...h, last_seen_at: longAgo() }));
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(h1()).toBe("Statuses can't be confirmed — no host is reporting normally.");
  });
});

describe("dashboard with the offline banner through an outage", () => {
  it("keeps the cards, agrees with the banner, and recovers on its own", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(banner()).toBe("");

    fail.sessions = "api";
    fail.hosts = "api";
    await poll("sessions", "hosts");
    // Straight away: kept, stale, and said so inline; the banner waits for its threshold.
    expect(card(LAPTOP_SESSION).querySelector(".status")?.textContent).toBe("Needs approval");
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now, Stale");
    expect(refreshNotice()?.textContent).toMatch(/^Couldn't refresh sessions and host status — showing data from /);

    await advance(2 * 60_000);
    await poll("sessions", "hosts");
    expect(banner()).toMatch(/^Can't reach the backend — showing data from/);
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated 2m ago, Stale");
    expect(alerts()).toHaveLength(0);
    expect(h1()).toBe("Can't confirm right now — last known: 3 sessions need you.");

    fail.sessions = false;
    fail.hosts = false;
    await poll("sessions", "hosts");
    expect(banner()).toBe("");
    expect(refreshNotice()).toBeNull();
    expect(fresh(card(LAPTOP_SESSION))).toBe("Updated just now");
    expect(h1()).toBe("3 sessions need you.");
  });
});

describe("hosts list", () => {
  it("shows hosts when sessions fail, says counts are unavailable, and recovers", async () => {
    fail.sessions = "api";
    renderAt("/hosts");
    await screen.findByRole("link", { name: "Demo laptop" }, T);
    const notice = await findAlertWith("Sessions couldn't be loaded.");
    const laptop = screen.getByRole("link", { name: "Demo laptop" }).closest("li") as HTMLElement;
    expect(laptop.textContent).toContain("Unavailable");
    expect(laptop.textContent).toContain("Online");

    fail.sessions = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(alerts()).toHaveLength(0), T);
    expect(laptop.textContent).not.toContain("Unavailable");
  });

  it("shows the full error when the host list fails on first load", async () => {
    fail.hosts = "api";
    renderAt("/hosts");
    const error = await findAlertWith("The hosts service is down.");
    expect(error.textContent).not.toContain("couldn't be loaded");
    expect(screen.queryByRole("link", { name: "Demo laptop" })).toBeNull();
  });

  it("keeps the hosts after a failed refresh, marked stale", async () => {
    renderAt("/hosts");
    await screen.findByRole("link", { name: "Demo laptop" }, T);
    fail.hosts = "api";
    await poll("hosts");
    const laptop = screen.getByRole("link", { name: "Demo laptop" }).closest("li") as HTMLElement;
    expect(fresh(laptop)).toBe("Updated just now, Stale");
    expect(refreshNotice()?.textContent).toMatch(/^Couldn't refresh host status/);

    fail.hosts = false;
    await poll("hosts");
    expect(fresh(laptop)).toBe("Updated just now");
    expect(refreshNotice()).toBeNull();
  });

  it("has an empty state when no hosts are paired", async () => {
    hostsOverride = () => [];
    renderAt("/hosts");
    await screen.findByRole("heading", { name: "No hosts paired yet" }, T);
  });
});

describe("host detail", () => {
  it("shows the host when its sessions fail, with the error scoped to them", async () => {
    fail.sessions = "api";
    renderAt(`/hosts/${LAPTOP}`);
    await screen.findByRole("heading", { level: 1, name: "Demo laptop" }, T);
    const notice = await findAlertWith("Sessions couldn't be loaded.");
    expect(screen.getByRole("heading", { name: "Health" })).toBeTruthy();

    fail.sessions = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    expect(alerts()).toHaveLength(0);
  });

  it("keeps the host after a failed refresh", async () => {
    renderAt(`/hosts/${LAPTOP}`);
    await screen.findByRole("heading", { name: LAPTOP_SESSION }, T);
    fail.hosts = "api";
    await poll("hosts");
    expect(h1()).toBe("Demo laptop");
    expect(refreshNotice()).toBeTruthy();
    expect(alerts()).toHaveLength(0);
  });
});

describe("session detail", () => {
  it("shows the session without trusting its host when hosts fail, and recovers", async () => {
    const id = await liveSessionId();
    fail.hosts = "api";
    renderAt(`/sessions/${id}`);
    await screen.findByRole("heading", { level: 1, name: LAPTOP_SESSION }, T);
    alertWith("Host status couldn't be loaded.");
    const details = section("Details");
    expect(details.textContent).toContain("Host not loaded");
    expect(details.textContent).toContain("Status unknown");
    expect(screen.queryByRole("link", { name: /^All sessions on/ })).toBeNull();

    fail.hosts = false;
    await poll("hosts");
    expect(alerts()).toHaveLength(0);
    expect(section("Details").textContent).toContain("Demo laptop");
  });

  it("shows the history with a scoped error when the session list fails, and recovers on retry", async () => {
    const id = await liveSessionId();
    fail.sessions = "api";
    renderAt(`/sessions/${id}`);
    const notice = await findAlertWith("Session details couldn't be loaded.");
    expect(notice.textContent).toContain("The sessions service is down.");
    expect(await within(section("Status history")).findByText(/^Discovered · /, {}, T)).toBeTruthy();
    // Message content stays behind the session's own capability.
    expect(screen.queryByRole("heading", { name: "Recent messages" })).toBeNull();

    fail.sessions = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 1, name: LAPTOP_SESSION }, T);
    expect(alerts()).toHaveLength(0);
  });

  it("doesn't imply that an unconfirmed id exists while the session list fails", async () => {
    // Not one of the user's sessions: the database answers its history with [], not an error.
    fail.sessions = "api";
    renderAt("/sessions/00000000-0000-4000-8000-00000000ffff");
    const notice = await findAlertWith("Session details couldn't be loaded.");
    expect(notice.textContent).toContain("If this session exists, its recorded history appears below.");
    expect(notice.textContent).not.toContain("Its recorded history is below.");
    expect(await within(section("Status history")).findByText("No recorded history to show.", {}, T)).toBeTruthy();
    expect(screen.queryByText("No status changes recorded yet.")).toBeNull();
  });

  it("shows one full error when the session list and its history both fail", async () => {
    const id = await liveSessionId();
    fail.sessions = "api";
    fail.events = "api";
    renderAt(`/sessions/${id}`);
    await findAlertWith("The sessions service is down.");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Status history" })).toBeNull(), T);
    expect(alerts()).toHaveLength(1);
  });

  it("scopes a history or messages failure to its panel, and recovers", async () => {
    const id = await liveSessionId();
    fail.events = "api";
    fail.messages = "api";
    renderAt(`/sessions/${id}`);
    await screen.findByRole("heading", { level: 1, name: LAPTOP_SESSION }, T);
    const history = await waitFor(() => within(section("Status history")).getByRole("alert"), T);
    const messages = await waitFor(() => within(section("Recent messages")).getByRole("alert"), T);
    expect(history.textContent).toContain("The events service is down.");
    expect(messages.textContent).toContain("The messages service is down.");
    expect(alerts()).toHaveLength(2);

    fail.events = false;
    fireEvent.click(within(history).getByRole("button", { name: "Try again" }));
    await within(section("Status history")).findByText(/^Discovered · /, {}, T);
    expect(within(section("Recent messages")).getByRole("alert")).toBeTruthy();
  });

  it("keeps the session and its history after failed refreshes", async () => {
    const id = await liveSessionId();
    renderAt(`/sessions/${id}`);
    await within(await waitFor(() => section("Status history"), T)).findByText(/^Discovered · /, {}, T);
    fail.sessions = "api";
    fail.events = "api";
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["sessions"] });
    });
    expect(h1()).toBe(LAPTOP_SESSION);
    expect(refreshNotice()?.textContent).toMatch(/^Couldn't refresh sessions/);
    const history = section("Status history");
    expect(within(history).getByText(/^Discovered · /)).toBeTruthy();
    expect(within(history).getByRole("alert").textContent).toContain("Couldn't refresh the history.");
  });
});
