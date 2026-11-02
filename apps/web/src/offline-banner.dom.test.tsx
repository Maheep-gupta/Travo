// Component tests for the shell's offline banner (spec 3.5, 14.2, Part 16):
// browser offline events, stale, failing and paused data from the query cache,
// bounded retries, recovery, and TanStack Query's own refetch on reconnect.
// The banner never takes focus.
import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@mc/api-client/demo";
import { FETCH_GRACE_MS, MAX_FETCH_RETRIES, STALE_DATA_AFTER_MS, formatDataTime } from "./connectivity.js";
import { UserIdContext, createQueryClient } from "./hooks.js";
import { OfflineBanner } from "./offline-banner.js";

const USER = "u1";
const HOSTS = ["hosts", "demo", USER];

let queryClient: QueryClient;
let online = true;

function setOnline(next: boolean) {
  online = next;
  act(() => {
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  });
}

beforeEach(() => {
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  // TanStack's onlineManager is global: leave it online for the next test.
  setOnline(true);
  delete (window.navigator as { onLine?: boolean }).onLine;
  queryClient.clear();
});

/** A page-like observer of the user's hosts query, so reconnect behaviour is real. */
function HostsObserver({ queryFn }: { queryFn: () => Promise<string[]> }) {
  useQuery({ queryKey: HOSTS, queryFn });
  return null;
}

function renderBanner(extra?: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <UserIdContext value={USER}>
        <button type="button">Elsewhere</button>
        <OfflineBanner />
        {extra}
      </UserIdContext>
    </QueryClientProvider>,
  );
}

const region = () => screen.getByRole("status");
const text = () => (region().textContent ?? "").trim();

describe("OfflineBanner", () => {
  it("stays empty while data is current", () => {
    queryClient.setQueryData(HOSTS, []);
    renderBanner();
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(text()).toBe("");
  });

  it("appears when the browser goes offline, without moving focus, and clears when it's back", () => {
    const at = Date.now() - 20_000;
    queryClient.setQueryData(HOSTS, [], { updatedAt: at });
    renderBanner();
    const other = screen.getByRole("button", { name: "Elsewhere" });
    other.focus();

    setOnline(false);
    expect(text()).toContain(`Offline — showing data from ${formatDataTime(at, Date.now())}`);
    expect(text()).toContain("Statuses may have changed");
    expect(document.activeElement).toBe(other);

    setOnline(true);
    expect(text()).toBe("");
  });

  it("reports data older than the threshold that nothing has refreshed", () => {
    const at = Date.now() - STALE_DATA_AFTER_MS - 5_000;
    queryClient.setQueryData(HOSTS, [], { updatedAt: at });
    renderBanner();
    expect(text()).toContain(`Not updated since ${formatDataTime(at, Date.now())}`);
  });

  it("reports an unreachable backend when fetches fail after old data, then recovers on success", async () => {
    const at = Date.now() - STALE_DATA_AFTER_MS - 5_000;
    queryClient.setQueryData(HOSTS, [], { updatedAt: at });
    renderBanner();
    await act(async () => {
      await queryClient.fetchQuery({ queryKey: HOSTS, queryFn: () => Promise.reject(new ApiError("down", "unavailable")), staleTime: 0 }).catch(() => undefined);
    });
    expect(text()).toContain(`Can't reach the backend — showing data from ${formatDataTime(at, Date.now())}`);

    act(() => {
      queryClient.setQueryData(HOSTS, ["h1"]);
    });
    expect(text()).toBe("");
  });

  it("ignores other users' queries", () => {
    queryClient.setQueryData(HOSTS, []);
    queryClient.setQueryData(["hosts", "demo", "someone-else"], [], { updatedAt: Date.now() - 10 * STALE_DATA_AFTER_MS });
    renderBanner();
    expect(text()).toBe("");
  });

  it("relies on TanStack Query to refetch on reconnect (no duplicate refetch of its own)", async () => {
    const queryFn = vi.fn(() => Promise.resolve(["h1"]));
    renderBanner(<HostsObserver queryFn={queryFn} />);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    setOnline(false);
    setOnline(true);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(text()).toBe("");
  });

  it("gives an in-flight refetch of old data a short grace before reporting it stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const at = Date.now() - STALE_DATA_AFTER_MS - 5_000;
      queryClient.setQueryData(HOSTS, [], { updatedAt: at });
      let finish: (hosts: string[]) => void = () => undefined;
      renderBanner();
      // e.g. a frozen tab resuming: the refetch is already on its way.
      act(() => {
        void queryClient.fetchQuery({ queryKey: HOSTS, queryFn: () => new Promise<string[]>((resolve) => (finish = resolve)), staleTime: 0 });
      });
      expect(text()).toBe("");

      // Still running after the grace: say so rather than wait forever.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FETCH_GRACE_MS + 5_000);
      });
      expect(text()).toContain(`Not updated since ${formatDataTime(at, Date.now())}`);

      await act(async () => {
        finish(["h1"]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(text()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Polls the user's hosts like AlertWatcher does (every heartbeat). */
function PollingHosts({ queryFn }: { queryFn: () => Promise<unknown[]> }) {
  useQuery({ queryKey: HOSTS, queryFn, refetchInterval: 30_000 });
  return null;
}

describe("OfflineBanner with the app's query client (outage and recovery)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    queryClient = createQueryClient();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("backs off during an outage, keeps the poll cadence, and clears once a fetch succeeds, without a reload", async () => {
    const at = Date.now() - STALE_DATA_AFTER_MS - 5_000;
    queryClient.setQueryData(HOSTS, [], { updatedAt: at });
    let up = false;
    const queryFn = vi.fn(() => (up ? Promise.resolve(["h1"]) : Promise.reject(new ApiError("down", "unavailable"))));
    renderBanner(<PollingHosts queryFn={queryFn} />);

    // The mount fetch plus MAX_FETCH_RETRIES retries after 1 s and 2 s.
    await advance(3_500);
    expect(queryFn).toHaveBeenCalledTimes(1 + MAX_FETCH_RETRIES);
    expect(text()).toContain(`Can't reach the backend — showing data from ${formatDataTime(at, Date.now())}`);

    // Nothing more until the next poll; then the same bounded burst, not more.
    await advance(20_000);
    expect(queryFn).toHaveBeenCalledTimes(1 + MAX_FETCH_RETRIES);
    await advance(15_000);
    expect(queryFn).toHaveBeenCalledTimes(2 * (1 + MAX_FETCH_RETRIES));

    up = true;
    await advance(30_000);
    expect(queryFn).toHaveBeenCalledTimes(2 * (1 + MAX_FETCH_RETRIES) + 1);
    expect(text()).toBe("");
  });

  it("reports a paused project at once, doesn't retry it, and clears once the project is restored", async () => {
    queryClient.setQueryData(HOSTS, [], { updatedAt: Date.now() - 10_000 });
    let paused = true;
    const queryFn = vi.fn(() => (paused ? Promise.reject(new ApiError("paused", "paused")) : Promise.resolve(["h1"])));
    renderBanner(<PollingHosts queryFn={queryFn} />);
    // Fresh data isn't refetched on mount (staleTime); the first poll finds the pause.
    await advance(30_500);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Your Supabase project is paused — showing data from");
    expect(text()).toContain("Restore it from the project's page in the Supabase dashboard");
    expect(document.querySelector(".offline-banner.unreachable.paused")).not.toBeNull();

    await advance(10_000);
    expect(queryFn).toHaveBeenCalledTimes(1);

    paused = false;
    await advance(20_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(text()).toBe("");
  });

  it("doesn't blame the backend for a laptop that stopped reporting (that is the host card's job)", async () => {
    const silentHost = { id: "h1", last_seen_at: new Date(Date.now() - 6 * 3_600_000).toISOString(), provider_error_since: null, revoked_at: null };
    queryClient.setQueryData(HOSTS, [silentHost]);
    renderBanner();
    await advance(5_000);
    expect(text()).toBe("");
  });
});
