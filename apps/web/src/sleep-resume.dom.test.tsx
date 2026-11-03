// The alert watcher across sleep and resume (spec 4.2, 5.7 "no false
// disconnection alerts during sleep", Part 16 "laptop sleep and restart").
// A suspended machine or frozen tab runs no timers: that is simulated by moving
// the system clock without advancing timers, after which the next poll fires.
import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, ChangeTopic, SignOutResult, TavroApi } from "@mc/api-client/demo";
import type { HostRow, NotificationPrefs, PairingTicket, SessionEventRow, SessionMessageRow, SessionRow, SessionStatus } from "@mc/contracts";
import { MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import { DISCONNECT_AFTER_MS, HEARTBEAT_INTERVAL_MS } from "@mc/domain";
import { alertStorageKey } from "./alert-store.js";
import { AlertsProvider } from "./alerts-context.js";
import { ApiProvider, useApiContext } from "./api-context.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

const USER: AuthUser = { id: "00000000-0000-4000-8000-000000000001", email: null };
const HOST = "00000000-0000-4000-8000-0000000000b1";
const S1 = "00000000-0000-4000-8000-000000000101";
const S2 = "00000000-0000-4000-8000-000000000102";
const S3 = "00000000-0000-4000-8000-000000000103";
const START = Date.parse("2026-10-29T10:00:00.000Z");
const MINUTE = 60_000;
const ALL_ON: NotificationPrefs = { on_waiting_for_input: true, on_approval_required: true, on_completed: true, on_failed: true, on_host_disconnected: true, on_host_reconnected: true };

/** A backend holding what the laptop last wrote. `heartbeating` = the laptop's connector is awake. */
class FakeApi implements TavroApi {
  readonly kind = "demo" as const;
  heartbeating = true;
  lastSeen = new Date(START).toISOString();
  statuses: Record<string, SessionStatus> = { [S1]: "running", [S2]: "running", [S3]: "running" };
  activityAt = new Date(START).toISOString();
  hostFetches = 0;

  getSchemaVersion(): Promise<number | null> {
    return Promise.resolve(MAX_SCHEMA_VERSION);
  }
  getUser(): Promise<AuthUser | null> {
    return Promise.resolve(USER);
  }
  signIn(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  signOut(): Promise<SignOutResult> {
    return Promise.reject(new Error("not used"));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  onAuthChange(): () => void {
    return () => undefined;
  }
  listSessions(): Promise<SessionRow[]> {
    return Promise.resolve(
      Object.entries(this.statuses).map(([id, status]) => ({
        id,
        owner_id: USER.id,
        host_id: HOST,
        provider: "mock" as const,
        external_id: id,
        title: id,
        project_label: null,
        status,
        status_reason: null,
        status_source: "mock" as const,
        last_activity_at: this.activityAt,
        last_event_summary: null,
        capabilities: ["discover" as const],
        is_demo: true,
        started_at: null,
        ended_at: null,
        updated_at: this.activityAt,
      })),
    );
  }
  getSession(): Promise<SessionRow | null> {
    return Promise.resolve(null);
  }
  listEvents(): Promise<SessionEventRow[]> {
    return Promise.resolve([]);
  }
  listMessages(): Promise<SessionMessageRow[]> {
    return Promise.resolve([]);
  }
  listHosts(): Promise<HostRow[]> {
    this.hostFetches += 1;
    // An awake connector heartbeats every 30 s; model it as "seen just now".
    if (this.heartbeating) this.lastSeen = new Date().toISOString();
    const at = new Date(START).toISOString();
    return Promise.resolve([
      { id: HOST, owner_id: USER.id, name: "Laptop", platform: "simulated", connector_version: "test", remote_control_allowed: false, last_seen_at: this.lastSeen, provider_error_since: null, paired_at: at, revoked_at: null, created_at: at },
    ]);
  }
  createHostPairing(): Promise<PairingTicket> {
    return Promise.reject(new Error("not used"));
  }
  revokeHost(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  getNotificationPrefs(): Promise<NotificationPrefs | null> {
    return Promise.resolve(ALL_ON);
  }
  saveNotificationPrefs(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  subscribe(_cb: (topic: ChangeTopic) => void): () => void {
    return () => undefined;
  }
}

let api: FakeApi;
let queryClient: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  api = new FakeApi();
  backend.api = api;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
  window.localStorage.clear();
  vi.useRealTimers();
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api: ready } = useApiContext();
  return ready ? children : null;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function open(): Promise<void> {
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter>
          <ApiReady>
            <AlertsProvider userId={USER.id}>{null}</AlertsProvider>
          </ApiReady>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
  await flush(10);
  expect(api.hostFetches).toBeGreaterThanOrEqual(1);
}

/** Lets the watcher's polls run for `ms`, as when the device is awake. */
async function awake(ms: number): Promise<void> {
  await flush(ms);
  // TanStack Query notifies observers on its own short timer: let a poll that fired at the very end deliver.
  await flush(5);
}

/** The device is suspended for `ms`: no timers run, then the clock has moved on. */
async function sleep(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await flush(0);
}

const alerts = (): string[] =>
  (JSON.parse(window.localStorage.getItem(alertStorageKey("demo", USER.id)) ?? "[]") as { kind: string; sessionId: string | null }[])
    .map((a) => `${a.kind}${a.sessionId ? `:${a.sessionId}` : ""}`)
    .sort();

describe("laptop sleeps while this tab (on another device) keeps watching", () => {
  it("alerts one disconnection and, on resume, one reconnection plus only the real changes", async () => {
    await open();
    await awake(MINUTE);
    api.heartbeating = false; // lid closed
    await awake(5 * MINUTE);
    expect(alerts()).toEqual(["host_disconnected"]);

    // Back after the sleep: one session changed, one was closed, one is unchanged.
    api.heartbeating = true;
    api.statuses = { [S1]: "waiting_for_input", [S2]: "ended", [S3]: "running" };
    api.activityAt = new Date().toISOString();
    await awake(HEARTBEAT_INTERVAL_MS);
    await awake(3 * MINUTE);
    expect(alerts()).toEqual(["host_disconnected", "host_reconnected", `waiting_for_input:${S1}`].sort());
  });
});

describe("this tab suspended (phone locked) while the laptop keeps working", () => {
  it("doesn't call the laptop disconnected on resume, and alerts the change once", async () => {
    await open();
    await awake(MINUTE);
    // The laptop works on while the tab is frozen for 30 minutes.
    await sleep(30 * MINUTE);
    api.statuses = { ...api.statuses, [S1]: "completed" };
    api.activityAt = new Date().toISOString();
    // The first poll after resume.
    const before = api.hostFetches;
    await awake(HEARTBEAT_INTERVAL_MS);
    expect(api.hostFetches).toBeGreaterThan(before);
    expect(alerts()).toEqual([`completed:${S1}`]);
    await awake(3 * MINUTE);
    expect(alerts()).toEqual([`completed:${S1}`]);
  });

  it("shows nothing from the cached copy before the first refetch lands", async () => {
    await open();
    await awake(MINUTE);
    await sleep(30 * MINUTE);
    // No timer has run yet: the watcher has only its pre-sleep data, judged at its own fetch time.
    expect(alerts()).toEqual([]);
  });
});

describe("laptop and this browser asleep together (lid closed)", () => {
  it("raises no disconnection when the browser fetches before the connector's first heartbeat", async () => {
    await open();
    await awake(MINUTE);
    api.heartbeating = false;
    await sleep(45 * MINUTE);
    // Both resume; the connector is still waiting for the network on the first two polls.
    await awake(2 * HEARTBEAT_INTERVAL_MS);
    expect(alerts()).toEqual([]);
    api.heartbeating = true;
    api.statuses = { ...api.statuses, [S2]: "failed" };
    api.activityAt = new Date().toISOString();
    await awake(3 * MINUTE);
    expect(alerts()).toEqual([`failed:${S2}`]);
  });

  it("reports a dead laptop to a tab opened for 30 s every few minutes", async () => {
    await open();
    await awake(MINUTE);
    api.heartbeating = false; // the laptop dies; this tab is suspended between short looks
    for (let look = 0; look < 3; look += 1) {
      await sleep(5 * MINUTE);
      await awake(HEARTBEAT_INTERVAL_MS);
    }
    expect(alerts()).toEqual(["host_disconnected"]);
  });

  it("still reports a host that doesn't come back within the grace", async () => {
    await open();
    await awake(MINUTE);
    api.heartbeating = false;
    await sleep(45 * MINUTE);
    await awake(DISCONNECT_AFTER_MS + 2 * HEARTBEAT_INTERVAL_MS);
    expect(alerts()).toEqual(["host_disconnected"]);
  });
});
