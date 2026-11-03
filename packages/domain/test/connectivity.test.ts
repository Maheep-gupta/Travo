// Offline banner rules (spec 3.5, 14.2, Part 16): when the data on screen stops
// being presented as current, what the banner says, and how failed fetches retry.
import { describe, expect, it } from "vitest";
import {
  FETCH_GRACE_MS,
  MAX_FETCH_RETRIES,
  RETRY_DELAY_CAP_MS,
  STALE_DATA_AFTER_MS,
  connectionIndicator,
  connectionMessage,
  connectionState,
  fetchFailureOf,
  fetchRetryDelay,
  formatDataTime,
  isStatusQuery,
  shouldRetryFetch,
  summarizeQueries,
  type QueryLike,
} from "../src/index.js";

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
    expect(connectionState(false, { ...fresh, lastFailureAt: NOW, lastFailure: "paused" }, NOW).kind).toBe("offline");
  });

  it("leaves a first load to the pages (no data yet is not stale data)", () => {
    expect(connectionState(true, { lastSuccessAt: null, lastFailureAt: NOW - 1000, fetchingSince: null }, NOW)).toEqual({ kind: "current" });
    expect(connectionState(true, { lastSuccessAt: null, lastFailureAt: NOW - 1000, lastFailure: "unavailable", fetchingSince: null }, NOW)).toEqual({ kind: "current" });
  });

  it("is unreachable when old data is followed by a failure, even while retrying", () => {
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: NOW - 5000, fetchingSince: NOW - 1000 }, NOW)).toEqual({ kind: "unreachable", dataFrom: old, cause: "unavailable" });
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: NOW - 5000, lastFailure: "other", fetchingSince: null }, NOW)).toEqual({ kind: "unreachable", dataFrom: old, cause: "error" });
  });

  it("ignores a failure older than the latest success", () => {
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: old - 1, fetchingSince: null }, NOW)).toEqual({ kind: "stale", dataFrom: old });
  });

  it("gives an in-flight refetch a short grace period, then reports stale", () => {
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: null, fetchingSince: NOW - FETCH_GRACE_MS + 1 }, NOW)).toEqual({ kind: "current" });
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: null, fetchingSince: NOW - FETCH_GRACE_MS }, NOW)).toEqual({ kind: "stale", dataFrom: old });
  });

  it("reports a paused project at once, with or without data, since it needs the owner to act", () => {
    expect(connectionState(true, { ...fresh, lastFailureAt: NOW - 1000, lastFailure: "paused" }, NOW)).toEqual({ kind: "unreachable", dataFrom: fresh.lastSuccessAt, cause: "paused" });
    expect(connectionState(true, { lastSuccessAt: null, lastFailureAt: NOW - 1000, lastFailure: "paused", fetchingSince: NOW }, NOW)).toEqual({ kind: "unreachable", dataFrom: null, cause: "paused" });
    expect(connectionState(true, { lastSuccessAt: old, lastFailureAt: NOW - 1000, lastFailure: "paused", fetchingSince: null }, NOW)).toEqual({ kind: "unreachable", dataFrom: old, cause: "paused" });
  });

  it("recovers as soon as a fetch succeeds after the pause", () => {
    expect(connectionState(true, { lastSuccessAt: NOW - 100, lastFailureAt: NOW - 1000, lastFailure: "paused", fetchingSince: null }, NOW)).toEqual({ kind: "current" });
  });
});

describe("fetchFailureOf", () => {
  it("reads the api-client error codes and calls everything else other", () => {
    expect(fetchFailureOf({ code: "paused" })).toBe("paused");
    expect(fetchFailureOf({ code: "unavailable" })).toBe("unavailable");
    for (const e of [{ code: "unauthorized" }, { code: "unknown" }, new Error("x"), null, undefined, "paused"]) expect(fetchFailureOf(e)).toBe("other");
  });
});

describe("summarizeQueries", () => {
  const q = (key: readonly unknown[], dataUpdatedAt: number, errorUpdatedAt = 0, fetchStatus = "idle", error?: unknown): QueryLike => ({
    queryKey: key,
    state: { dataUpdatedAt, errorUpdatedAt, fetchStatus, error },
  });

  it("only reads the signed-in user's queries", () => {
    const s = summarizeQueries(
      [q(["hosts", "demo", "u1"], 100, 0), q(["sessions", "demo", "u1", "list"], 300, 250), q(["hosts", "demo", "u2"], 1, 999, "fetching"), q(["schema", "demo"], 1)],
      "u1",
    );
    expect(s).toEqual({ lastSuccessAt: 100, lastFailureAt: 250, lastFailure: "other", fetching: false });
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
        q(["prefs", "demo", "u1"], old, NOW, "fetching", { code: "paused" }),
        q(["sessions", "demo", "u1", "events", "s1"], old),
        q(["sessions", "demo", "u1", "messages", "s1"], old),
      ],
      "u1",
    );
    expect(s).toEqual({ lastSuccessAt: NOW - 1_000, lastFailureAt: null, lastFailure: null, fetching: false });
    expect(isStatusQuery(["sessions", "demo", "u1", "list"], "u1")).toBe(true);
    expect(isStatusQuery(["sessions", "demo", "u2", "list"], "u1")).toBe(false);
  });

  it("leaves a list that never loaded to its page", () => {
    expect(summarizeQueries([q(["hosts", "demo", "u1"], NOW - 1_000), q(["sessions", "demo", "u1", "list"], 0, NOW - 500)], "u1")).toEqual({
      lastSuccessAt: NOW - 1_000,
      lastFailureAt: NOW - 500,
      lastFailure: "other",
      fetching: false,
    });
  });

  it("takes the failure kind from the latest failure", () => {
    const s = summarizeQueries(
      [q(["hosts", "demo", "u1"], 100, 400, "idle", { code: "paused" }), q(["sessions", "demo", "u1", "list"], 100, 300, "idle", { code: "unavailable" })],
      "u1",
    );
    expect(s).toMatchObject({ lastFailureAt: 400, lastFailure: "paused" });
    const t = summarizeQueries(
      [q(["hosts", "demo", "u1"], 100, 200, "idle", { code: "paused" }), q(["sessions", "demo", "u1", "list"], 100, 300, "idle", { code: "unavailable" })],
      "u1",
    );
    expect(t).toMatchObject({ lastFailureAt: 300, lastFailure: "unavailable" });
  });

  it("counts fetching but not paused (waiting for network) queries", () => {
    expect(summarizeQueries([q(["hosts", "demo", "u1"], 1, 0, "paused")], "u1").fetching).toBe(false);
    expect(summarizeQueries([q(["hosts", "demo", "u1"], 1, 0, "fetching")], "u1").fetching).toBe(true);
  });

  it("treats 0 timestamps as never", () => {
    expect(summarizeQueries([q(["hosts", "demo", "u1"], 0, 0)], "u1")).toEqual({ lastSuccessAt: null, lastFailureAt: null, lastFailure: null, fetching: false });
  });
});

describe("connectionMessage", () => {
  const t = () => "14:05";

  it("says nothing while current", () => {
    expect(connectionMessage({ kind: "current" }, t)).toBeNull();
  });

  it("names the time of the data shown and never calls it live", () => {
    expect(connectionMessage({ kind: "offline", dataFrom: 1 }, t)?.title).toBe("Offline — showing data from 14:05");
    expect(connectionMessage({ kind: "unreachable", dataFrom: 1, cause: "unavailable" }, t)?.title).toBe("Can't reach the backend — showing data from 14:05");
    expect(connectionMessage({ kind: "unreachable", dataFrom: 1, cause: "paused" }, t)?.title).toBe("Your Supabase project is paused — showing data from 14:05");
    expect(connectionMessage({ kind: "stale", dataFrom: 1 }, t)?.title).toBe("Not updated since 14:05");
    // A refused or unusable answer doesn't send the user to check their connection or a pause.
    const refused = connectionMessage({ kind: "unreachable", dataFrom: 1, cause: "error" }, t);
    expect(refused?.title).toBe("Couldn't refresh your data — showing data from 14:05");
    expect(`${refused?.title} ${refused?.detail}`).not.toMatch(/connection|paused|reach/i);
    for (const s of [
      { kind: "offline", dataFrom: 1 },
      { kind: "unreachable", dataFrom: 1, cause: "unavailable" },
      { kind: "unreachable", dataFrom: 1, cause: "paused" },
      { kind: "unreachable", dataFrom: 1, cause: "error" },
      { kind: "stale", dataFrom: 1 },
    ] as const) {
      const m = connectionMessage(s, t);
      expect(m?.detail).toContain("Statuses may have changed");
      expect(`${m?.title} ${m?.detail}`).not.toMatch(/\b(live|current|up to date)\b/i);
    }
  });

  it("says a paused project must be restored, and that an unreachable one may be paused", () => {
    expect(connectionMessage({ kind: "unreachable", dataFrom: 1, cause: "paused" }, t)?.detail).toMatch(/Restore it from the project's page in the Supabase dashboard/);
    expect(connectionMessage({ kind: "unreachable", dataFrom: null, cause: "paused" }, t)).toEqual({
      title: "Your Supabase project is paused",
      detail: "Restore it from the project's page in the Supabase dashboard; Tavro reconnects on its own.",
    });
    expect(connectionMessage({ kind: "unreachable", dataFrom: 1, cause: "unavailable" }, t)?.detail).toMatch(/Tavro keeps retrying\..*whether your Supabase project was paused/);
  });

  it("handles offline before anything loaded", () => {
    expect(connectionMessage({ kind: "offline", dataFrom: null }, t)?.title).toBe("Offline");
  });
});

describe("shouldRetryFetch / fetchRetryDelay", () => {
  it("retries transient failures a capped number of times", () => {
    for (const code of ["unavailable", "unknown"]) {
      expect(shouldRetryFetch(0, { code })).toBe(true);
      expect(shouldRetryFetch(MAX_FETCH_RETRIES - 1, { code })).toBe(true);
      expect(shouldRetryFetch(MAX_FETCH_RETRIES, { code })).toBe(false);
    }
    expect(MAX_FETCH_RETRIES).toBe(2);
  });

  it("never retries what retrying can't fix", () => {
    for (const code of ["unauthorized", "misconfigured", "forbidden", "not_found", "invalid", "paused"]) expect(shouldRetryFetch(0, { code })).toBe(false);
    // e.g. a response that failed schema validation.
    expect(shouldRetryFetch(0, new Error("parse"))).toBe(false);
    expect(shouldRetryFetch(0, null)).toBe(false);
  });

  it("backs off exponentially up to a ceiling", () => {
    expect([0, 1, 2, 3, 4, 10].map(fetchRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, RETRY_DELAY_CAP_MS, RETRY_DELAY_CAP_MS]);
    expect(RETRY_DELAY_CAP_MS).toBe(10_000);
  });
});

describe("formatDataTime", () => {
  it("shows the time for today and adds the date for another day", () => {
    expect(formatDataTime(Date.UTC(2026, 10, 2, 14, 5), NOW, "en-GB", "UTC")).toBe("14:05");
    expect(formatDataTime(Date.UTC(2026, 10, 1, 9, 7), NOW, "en-GB", "UTC")).toBe("1 Nov, 09:07");
  });
});

describe("connectionIndicator", () => {
  it("says Connected only while the data is current, and agrees with the banner otherwise", () => {
    expect(connectionIndicator({ kind: "current" })).toEqual({ tone: "ok", text: "Supabase", label: "Connected to your Supabase project" });
    const others = [
      { kind: "offline", dataFrom: 1 },
      { kind: "unreachable", dataFrom: 1, cause: "unavailable" },
      { kind: "unreachable", dataFrom: 1, cause: "paused" },
      { kind: "unreachable", dataFrom: 1, cause: "error" },
      { kind: "stale", dataFrom: 1 },
    ] as const;
    for (const s of others) {
      const pill = connectionIndicator(s);
      expect(pill.tone).not.toBe("ok");
      expect(`${pill.text} ${pill.label}`).not.toMatch(/connected/i);
    }
    expect(connectionIndicator({ kind: "unreachable", dataFrom: null, cause: "paused" }).text).toBe("Paused");
  });
});
