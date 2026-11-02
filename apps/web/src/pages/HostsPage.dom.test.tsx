// Component tests for the Hosts list: freshness on host cards (G4) and the
// pairing confirmation (spec 11.3), which must not claim success until the
// new host has actually heartbeated. Pairing needs a non-demo backend, so the
// demo backend is wrapped to look like one with a scripted new host.
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type TavroApi } from "@mc/api-client/demo";
import type { HostRow, PairingTicket } from "@mc/contracts";
import { ApiProvider, useApiContext } from "../api-context.js";
import { UserIdContext } from "../hooks.js";
import { PAIRING_POLL_GRACE_MS, PAIRING_POLL_MS } from "@mc/domain";
import { HostsPage } from "./HostsPage.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

// jsdom has no layout or computed colours, so contrast stays a manual check.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const NEW_HOST = "00000000-0000-4000-8000-0000000000b1";
let queryClient: QueryClient;
/** The host row created by pairing; null until a code is created. */
let newHost: HostRow | null;
let ticketExpiresAt: string;
/** When true, listHosts fails (the backend is unreachable). */
let hostsFail: boolean;

function pairingBackend(): TavroApi {
  const demo = createDemoApi({ tickMs: 0, sourceOutageMs: 0 });
  return {
    ...demo,
    kind: "supabase",
    listHosts: async () => {
      if (hostsFail) throw new Error("backend unreachable");
      return [...(await demo.listHosts()), ...(newHost ? [newHost] : [])];
    },
    createHostPairing: async (name: string): Promise<PairingTicket> => {
      newHost = {
        id: NEW_HOST,
        owner_id: DEMO_USER,
        name,
        platform: null,
        connector_version: null,
        remote_control_allowed: null,
        last_seen_at: null,
        provider_error_since: null,
        paired_at: null,
        revoked_at: null,
        created_at: new Date().toISOString(),
      };
      return { host_id: NEW_HOST, code: "ABCD-EFGH-JKLM", expires_at: ticketExpiresAt };
    },
  };
}

beforeEach(() => {
  newHost = null;
  hostsFail = false;
  ticketExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  backend.api = pairingBackend();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
  vi.useRealTimers();
});

/** Lets the pairing poll fire once (fake timers that also follow real time, so awaits still work). */
async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS + 10);
  });
}

/** Updates the scripted new host; the next poll (or refetch) returns it. */
function setNewHost(patch: Partial<HostRow>) {
  if (!newHost) throw new Error("pairing did not create a host");
  newHost = { ...newHost, ...patch };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ticketEl = () => screen.getByText("ABCD-EFGH-JKLM").closest(".ticket") as HTMLElement;

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  return api ? <UserIdContext value={DEMO_USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function renderHosts() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={["/hosts"]}>
          <ApiReady>
            <Routes>
              <Route path="/hosts" element={<HostsPage />} />
            </Routes>
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const hostCard = (name: string) => screen.getByRole("link", { name }).closest("li") as HTMLElement;

async function createCode(name = "Work laptop") {
  await screen.findByRole("link", { name: "Demo laptop" }, { timeout: 5000 });
  fireEvent.change(screen.getByRole("textbox", { name: "Host name" }), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
  return screen.findByText("ABCD-EFGH-JKLM", {}, { timeout: 5000 });
}

describe("HostsPage freshness", () => {
  it("shows when each host's data was last read and marks an offline host stale", async () => {
    renderHosts();
    await screen.findByRole("link", { name: "Demo laptop" }, { timeout: 5000 });
    const online = hostCard("Demo laptop").querySelector(".fresh") as HTMLElement;
    expect(online.textContent).toBe("Updated just now");
    const offline = hostCard("Demo desktop (switched off)").querySelector(".fresh") as HTMLElement;
    expect(offline.textContent).toMatch(/^Updated \d+h ago, Stale$/);
  });
});

describe("HostsPage pairing confirmation", () => {
  it("waits for the connector and says Connected only after the new host heartbeats", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHosts();
    await createCode();
    const ticket = ticketEl();
    expect(ticket.getAttribute("role")).toBe("status");
    expect(within(ticket).getByText(/Waiting for the connector to connect/)).toBeTruthy();
    expect(within(ticket).queryByText(/^Connected/)).toBeNull();

    // The connector exchanges the code: still not connected until it heartbeats.
    setNewHost({ paired_at: new Date().toISOString() });
    await nextPoll();
    expect(within(ticket).getByText(/Code accepted\. Waiting for the connector's first heartbeat/)).toBeTruthy();
    expect(within(ticket).queryByText(/^Connected/)).toBeNull();

    setNewHost({ last_seen_at: new Date().toISOString() });
    await nextPoll();
    expect(within(ticket).getByText(/^Connected\. The connector is reporting\./)).toBeTruthy();
    expect(within(ticket).getByRole("link", { name: "View Work laptop" }).getAttribute("href")).toBe(`/hosts/${NEW_HOST}`);
  });

  it("says when a connector connected but stopped reporting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHosts();
    await createCode();
    setNewHost({ paired_at: ago(10 * 60_000), last_seen_at: ago(5 * 60_000) });
    await nextPoll();
    expect(within(ticketEl()).getByText(/connected but has stopped reporting/)).toBeTruthy();
    expect(within(ticketEl()).queryByText(/^Connected/)).toBeNull();
  });

  it("says when the host was revoked while waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHosts();
    await createCode();
    setNewHost({ paired_at: ago(1_000), last_seen_at: ago(1_000), revoked_at: ago(500) });
    await nextPoll();
    expect(within(ticketEl()).getByText(/Not connected: this host was revoked/)).toBeTruthy();
    expect(within(ticketEl()).queryByText(/^Connected/)).toBeNull();
  });

  it("says it couldn't check, and keeps retrying, while the host list fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHosts();
    await createCode();
    hostsFail = true;
    await nextPoll();
    const ticket = ticketEl();
    expect(within(ticket).getByText(/Waiting for the connector to connect\..* Couldn't check just now; retrying\./)).toBeTruthy();

    hostsFail = false;
    setNewHost({ paired_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
    await nextPoll();
    expect(within(ticket).getByText(/^Connected\. The connector is reporting\./)).toBeTruthy();
    expect(within(ticket).queryByText(/Couldn't check just now/)).toBeNull();
  });

  it("stops polling long after the code expires, and offers Check again", async () => {
    // Already past the code's expiry plus the polling grace.
    ticketExpiresAt = ago(PAIRING_POLL_GRACE_MS + 60_000);
    renderHosts();
    await createCode();
    // The code was used, but the connector never heartbeated.
    setNewHost({ paired_at: ago(PAIRING_POLL_GRACE_MS) });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
    });
    const ticket = ticketEl();
    expect(within(ticket).getByText(/^Still not connected\. Check that the connector is running/)).toBeTruthy();

    setNewHost({ last_seen_at: new Date().toISOString() });
    fireEvent.click(within(ticket).getByRole("button", { name: "Check again" }));
    expect(await within(ticket).findByText(/^Connected\. The connector is reporting\./)).toBeTruthy();
    expect(within(ticket).queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("is honest when the code expires unused", async () => {
    ticketExpiresAt = new Date(Date.now() - 1_000).toISOString();
    renderHosts();
    await createCode();
    const ticket = screen.getByText("ABCD-EFGH-JKLM").closest(".ticket") as HTMLElement;
    await waitFor(() => expect(within(ticket).getByText(/Not connected: the code expired/)).toBeTruthy(), { timeout: 5000 });
    expect(within(ticket).queryByText(/^Connected/)).toBeNull();
  });

  it("has no axe violations while waiting for the connector", async () => {
    const { container } = renderHosts();
    await createCode();
    await screen.findByText(/Waiting for the connector to connect/, {}, { timeout: 5000 });
    expect(await axe(container)).toHaveNoViolations();
  });
});
