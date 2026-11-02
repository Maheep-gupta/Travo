// Offline banner rules (spec 3.5, 14.2): when the data on screen stops being
// presented as current, and what the banner says.
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@mc/api-client/demo";
import { AlertStore } from "./alert-store.js";
import { installState } from "./app-info.js";
import { FETCH_GRACE_MS, STALE_DATA_AFTER_MS, connectionMessage, connectionState, formatDataTime, isStatusQuery, summarizeQueries, type QueryLike } from "./connectivity.js";
import { clearLocalTavroData } from "./local-data.js";

const NOW = Date.UTC(2026, 10, 2, 14, 30);
const fresh = { lastSuccessAt: NOW - 10_000, lastFailureAt: null, fetchingSince: null };
const old = NOW - STALE_DATA_AFTER_MS - 1;

describe("connectionState", () => {
  it("uses the heartbeat-based threshold (three missed 30 s polls)", () => {
    expect(STALE_DATA_AFTER_MS).toBe(90_000);
  });

  it("is current while the latest success is within the threshold", () => {
    expect(connectionState(true, fresh, NOW)).toEqual({ kind: "current" });
    expect(connectionState(true, { ...fresh, lastSuccessAt: NOW - STALE_DATA_AFTER_MS }, NOW)).toEqual({ kind: "current" });
  });

  it("is offline whenever the browser says so, even with fresh data", () => {
    expect(connectionState(false, fresh, NOW)).toEqual({ kind: "offline", dataFrom: fresh.lastSuccessAt });
    expect(connectionState(false, { lastSuccessAt: null, lastFailureAt: null, fetchingSince: null }, NOW)).toEqual({ kind: "offline", dataFrom: null });
  });

  it("leaves a first load to the pages (no data yet is not stale data)", () => {
    expect(connectionState(true, { lastSuccessAt: null, lastFailureAt: NOW - 1000, fetchingSince: null }, NOW)).toEqual({ kind: "current" });
  });

  it("is unreachable when old data is followed by a failure, even while retrying", () => {
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: NOW - 5000, fetchingSince: NOW - 1000 }, NOW)).toEqual({ kind: "unreachable", dataFrom: old });
  });

  it("ignores a failure older than the latest success", () => {
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: old - 1, fetchingSince: null }, NOW)).toEqual({ kind: "stale", dataFrom: old });
  });

  it("gives an in-flight refetch a short grace period, then reports stale", () => {
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: null, fetchingSince: NOW - FETCH_GRACE_MS + 1 }, NOW)).toEqual({ kind: "current" });
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: null, fetchingSince: NOW - FETCH_GRACE_MS }, NOW)).toEqual({ kind: "stale", dataFrom: old });
  });
});

describe("summarizeQueries", () => {
  const q = (key: readonly unknown[], dataUpdatedAt: number, errorUpdatedAt = 0, fetchStatus = "idle"): QueryLike => ({
    queryKey: key,
    state: { dataUpdatedAt, errorUpdatedAt, fetchStatus },
  });

  it("only reads the signed-in user's queries", () => {
    const s = summarizeQueries(
      [q(["hosts", "demo", "u1"], 100, 0), q(["sessions", "demo", "u1", "list"], 300, 250), q(["hosts", "demo", "u2"], 1, 999, "fetching"), q(["schema", "demo"], 1)],
      "u1",
    );
    expect(s).toEqual({ lastSuccessAt: 100, lastFailureAt: 250, fetching: false });
  });

  it("judges by the oldest status query, so a fresh host list can't hide a stale session list", () => {
    const s = summarizeQueries([q(["hosts", "demo", "u1"], NOW - 1_000), q(["sessions", "demo", "u1", "list"], old)], "u1");
    expect(s.lastSuccessAt).toBe(old);
    expect(connectionState(true, { ...s, fetchingSince: null }, NOW)).toEqual({ kind: "stale", dataFrom: old });
  });

  it("ignores queries that don't carry statuses (preferences, events, messages)", () => {
    const s = summarizeQueries(
      [
        q(["hosts", "demo", "u1"], NOW - 1_000),
        q(["prefs", "demo", "u1"], old, NOW, "fetching"),
        q(["sessions", "demo", "u1", "events", "s1"], old),
        q(["sessions", "demo", "u1", "messages", "s1"], old),
      ],
      "u1",
    );
    expect(s).toEqual({ lastSuccessAt: NOW - 1_000, lastFailureAt: null, fetching: false });
    expect(isStatusQuery(["sessions", "demo", "u1", "list"], "u1")).toBe(true);
    expect(isStatusQuery(["sessions", "demo", "u2", "list"], "u1")).toBe(false);
  });

  it("leaves a list that never loaded to its page", () => {
    expect(summarizeQueries([q(["hosts", "demo", "u1"], NOW - 1_000), q(["sessions", "demo", "u1", "list"], 0, NOW - 500)], "u1")).toEqual({
      lastSuccessAt: NOW - 1_000,
      lastFailureAt: NOW - 500,
      fetching: false,
    });
  });

  it("counts fetching but not paused (waiting for network) queries", () => {
    expect(summarizeQueries([q(["hosts", "demo", "u1"], 1, 0, "paused")], "u1").fetching).toBe(false);
    expect(summarizeQueries([q(["hosts", "demo", "u1"], 1, 0, "fetching")], "u1").fetching).toBe(true);
  });

  it("treats 0 timestamps as never", () => {
    expect(summarizeQueries([q(["hosts", "demo", "u1"], 0, 0)], "u1")).toEqual({ lastSuccessAt: null, lastFailureAt: null, fetching: false });
  });
});

describe("connectionMessage", () => {
  const t = () => "14:05";

  it("says nothing while current", () => {
    expect(connectionMessage({ kind: "current" }, t)).toBeNull();
  });

  it("names the time of the data shown and never calls it live", () => {
    expect(connectionMessage({ kind: "offline", dataFrom: 1 }, t)?.title).toBe("Offline — showing data from 14:05");
    expect(connectionMessage({ kind: "unreachable", dataFrom: 1 }, t)?.title).toBe("Can't reach the backend — showing data from 14:05");
    expect(connectionMessage({ kind: "stale", dataFrom: 1 }, t)?.title).toBe("Not updated since 14:05");
    for (const kind of ["offline", "unreachable", "stale"] as const) {
      expect(connectionMessage({ kind, dataFrom: 1 } as never, t)?.detail).toContain("Statuses may have changed");
    }
  });

  it("handles offline before anything loaded", () => {
    expect(connectionMessage({ kind: "offline", dataFrom: null }, t)?.title).toBe("Offline");
  });
});

describe("formatDataTime", () => {
  it("shows the time for today and adds the date for another day", () => {
    expect(formatDataTime(Date.UTC(2026, 10, 2, 14, 5), NOW, "en-GB", "UTC")).toBe("14:05");
    expect(formatDataTime(Date.UTC(2026, 10, 1, 9, 7), NOW, "en-GB", "UTC")).toBe("1 Nov, 09:07");
  });
});

describe("installState", () => {
  const mm = (standalone: boolean) => (query: string) => ({ matches: standalone && query === "(display-mode: standalone)" });

  it("detects an installed app, a browser tab, and an unknown environment", () => {
    expect(installState({ matchMedia: mm(true) })).toBe("installed");
    expect(installState({ matchMedia: mm(false) })).toBe("browser");
    expect(installState({ matchMedia: mm(false), standalone: true })).toBe("installed");
    expect(installState({})).toBe("unknown");
  });
});

describe("clearLocalTavroData", () => {
  it("removes this account's alerts and this device's preferences, and nothing else", () => {
    const storage = new MemoryStorage();
    const store = new AlertStore(storage, "tavro.alerts.v1:demo:u1");
    store.add([{ id: "a1", kind: "failed", sessionId: "s1", hostId: "h1", at: new Date(NOW).toISOString(), isDemo: true }]);
    storage.setItem("tavro.theme.v1", "light");
    storage.setItem("tavro.systemNotifications.v1", "on");
    storage.setItem("tavro.systemNotificationNames.v1:tavro.alerts.v1:demo:u1", "on");
    storage.setItem("tavro.alerts.v1:demo:u2", "[]");
    storage.setItem("mc.backend", '{"kind":"demo"}');

    clearLocalTavroData(storage, store);

    expect(store.getSnapshot()).toEqual([]);
    expect(storage.getItem("tavro.alerts.v1:demo:u1")).toBe("[]");
    expect(storage.getItem("tavro.theme.v1")).toBeNull();
    expect(storage.getItem("tavro.systemNotifications.v1")).toBeNull();
    expect(storage.getItem("tavro.systemNotificationNames.v1:tavro.alerts.v1:demo:u1")).toBeNull();
    // Another account's list and the connection are left to their own controls.
    expect(storage.getItem("tavro.alerts.v1:demo:u2")).toBe("[]");
    expect(storage.getItem("mc.backend")).toBe('{"kind":"demo"}');
  });
});
