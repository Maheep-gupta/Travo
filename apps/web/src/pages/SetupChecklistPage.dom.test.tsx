// Component tests for the guided setup checklist (spec 11.2, 11.3): each step
// is derived from the host and session lists, the next step is marked with
// aria-current, loading and failures read as "can't tell" rather than "not
// done", and demo evidence is labelled. The demo backend is wrapped to look
// like a real project with scripted hosts and sessions.
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type TavroApi } from "@mc/api-client/demo";
import type { HostRow, SessionRow } from "@mc/contracts";
import { ApiProvider, useApiContext } from "../api-context.js";
import { UserIdContext } from "../hooks.js";
import { SetupChecklistPage } from "./SetupChecklistPage.js";

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

const USER = "00000000-0000-4000-8000-000000000001";
const HOST = "00000000-0000-4000-8000-0000000000c1";
let queryClient: QueryClient;
let hosts: HostRow[];
let hostsFail: boolean;
let sessions: SessionRow[];
let online: boolean;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function laptop(patch: Partial<HostRow> = {}): HostRow {
  return {
    id: HOST,
    owner_id: USER,
    name: "Work laptop",
    platform: "darwin",
    connector_version: "0.1.0",
    remote_control_allowed: false,
    last_seen_at: ago(1_000),
    provider_error_since: null,
    paired_at: ago(60_000),
    revoked_at: null,
    created_at: ago(120_000),
    ...patch,
  };
}

/** A real-looking project whose hosts and sessions are whatever the test says. */
function scriptedBackend(): TavroApi {
  const demo = createDemoApi({ tickMs: 0, sourceOutageMs: 0 });
  return {
    ...demo,
    kind: "supabase",
    listHosts: async () => {
      if (hostsFail) throw new Error("backend unreachable");
      return hosts;
    },
    listSessions: async () => sessions,
  };
}

beforeEach(() => {
  hosts = [];
  hostsFail = false;
  sessions = [];
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  backend.api = scriptedBackend();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  delete (window.navigator as { onLine?: boolean }).onLine;
  queryClient.clear();
  backend.api = null;
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  return api ? <UserIdContext value={USER}>{children}</UserIdContext> : <p>Starting test backend</p>;
}

function renderChecklist() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={["/setup"]}>
          <ApiReady>
            <Routes>
              <Route path="/setup" element={<SetupChecklistPage />} />
            </Routes>
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const stepList = () => screen.getByRole("list", { name: "Setup steps" });
const step = (title: string) => within(stepList()).getByText(title, { selector: ".setup-title" }).closest("li") as HTMLElement;
const currentSteps = () => within(stepList()).getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
const progress = () => document.querySelector(".setup-progress")?.textContent ?? "";

describe("SetupChecklistPage", () => {
  it("makes pairing the next step for a new project, with a link to do it", async () => {
    const { container } = renderChecklist();
    await waitFor(() => expect(step("Pair a host").getAttribute("aria-current")).toBe("step"), { timeout: 5000 });
    expect(progress()).toBe("2 of 6 steps done.");
    expect(step("Choose where your data lives").textContent).toContain("Done");
    expect(step("Sign in").textContent).toContain("Done");
    const pair = step("Pair a host");
    expect(currentSteps()).toEqual([pair]);
    expect(pair.textContent).toContain("Next step");
    expect(within(pair).getByRole("link", { name: "Pair a host" }).getAttribute("href")).toBe("/hosts");
    // Later steps wait on it, and have no action of their own yet.
    const heartbeat = step("Connector reporting");
    expect(heartbeat.textContent).toContain("Waiting");
    expect(heartbeat.textContent).toContain("Waits on “Pair a host”");
    expect(within(heartbeat).queryByRole("link")).toBeNull();
    // Notifications are optional and never hold setup back.
    expect(step("Decide on notifications").textContent).toMatch(/Optional|Done/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("confirms each step from evidence and says when setup is complete", async () => {
    hosts = [laptop()];
    sessions = [{ ...(await createDemoApi({ tickMs: 0 }).listSessions())[0], host_id: HOST, is_demo: false } as SessionRow];
    renderChecklist();
    await waitFor(() => expect(progress()).toBe("Setup complete."), { timeout: 5000 });
    expect(currentSteps()).toEqual([]);
    expect(step("Connector reporting").textContent).toContain("Work laptop is reporting.");
    expect(step("Session source answering").textContent).toContain("Done");
    expect(within(step("First session seen")).getByRole("link", { name: "View sessions" }).getAttribute("href")).toBe("/");
    // A real project: nothing is labelled demo.
    expect(screen.queryByText("Demo")).toBeNull();
  });

  it("points at the host whose connector stopped reporting", async () => {
    hosts = [laptop({ last_seen_at: ago(10 * 60_000) })];
    renderChecklist();
    const heartbeat = await waitFor(() => {
      const li = step("Connector reporting");
      expect(li.getAttribute("aria-current")).toBe("step");
      return li;
    }, { timeout: 5000 });
    expect(heartbeat.textContent).toMatch(/Work laptop last checked in 10m ago/);
    expect(within(heartbeat).getByRole("link", { name: "View Work laptop" }).getAttribute("href")).toBe(`/hosts/${HOST}`);
  });

  it("says a failing session source is the next thing to fix", async () => {
    hosts = [laptop({ provider_error_since: ago(5 * 60_000), provider_error_kind: "auth_required" })];
    renderChecklist();
    await waitFor(() => expect(step("Session source answering").getAttribute("aria-current")).toBe("step"), { timeout: 5000 });
    expect(step("Session source answering").textContent).toMatch(/has had a problem since 5m ago\. The host can't read its sessions: Claude Code isn't signed in on this computer\./);
  });

  it("reads a failed host list as can't tell, not as not done, and retries", async () => {
    hostsFail = true;
    renderChecklist();
    const pair = await waitFor(() => {
      const li = step("Pair a host");
      expect(li.textContent).toContain("couldn't be loaded");
      return li;
    }, { timeout: 5000 });
    expect(pair.getAttribute("aria-current")).toBeNull();
    expect(pair.textContent).toContain("Can't tell yet");
    expect(progress()).not.toMatch(/complete/);

    hostsFail = false;
    hosts = [laptop()];
    fireEvent.click(within(pair).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(step("Pair a host").textContent).toContain("Work laptop is paired."), { timeout: 5000 });
  });

  it("won't confirm a heartbeat while offline, but keeps what already happened", async () => {
    hosts = [laptop()];
    renderChecklist();
    await waitFor(() => expect(step("Connector reporting").textContent).toContain("Done"), { timeout: 5000 });
    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() => expect(step("Connector reporting").textContent).toMatch(/Can't tell yet.*you're offline/));
    expect(step("Pair a host").textContent).toContain("Done");
    expect(progress()).not.toMatch(/complete/);
    online = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
  });

  it("labels demo evidence as DEMO", async () => {
    backend.api = createDemoApi({ tickMs: 0, sourceOutageMs: 0 });
    renderChecklist();
    await waitFor(() => expect(step("Pair a host").textContent).toContain("Done"), { timeout: 5000 });
    expect(screen.getByText(/the hosts and sessions below are simulated/)).toBeTruthy();
    expect(within(step("Pair a host")).getByText("Demo")).toBeTruthy();
    expect(step("Pair a host").textContent).toMatch(/Simulated demo host/);
    expect(progress()).toMatch(/demo/i);
  });
});
