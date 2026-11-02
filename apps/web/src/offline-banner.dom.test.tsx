// Component tests for the shell's offline banner (spec 3.5, 14.2): browser
// offline events, stale and failing data from the query cache, recovery, and
// TanStack Query's own refetch on reconnect. The banner never takes focus.
import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@mc/api-client/demo";
import { FETCH_GRACE_MS, STALE_DATA_AFTER_MS, formatDataTime } from "./connectivity.js";
import { UserIdContext } from "./hooks.js";
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
