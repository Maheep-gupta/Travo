import { describe, expect, it } from "vitest";
import {
  HOST_NOT_LOADED_NAME,
  STALE_REASON_LABEL,
  buildSessionViews,
  countByState,
  hasSourceData,
  pageAvailability,
  refreshFailure,
  sourceState,
  statusIndicator,
  syncWithRefreshes,
  untrustedHostReason,
  type SourceState,
} from "../src/index.js";
import { CURRENT, now, session } from "./fixtures.js";

describe("sourceState", () => {
  it("tells a first load from a failed refresh", () => {
    expect(sourceState({ hasData: false, failed: false })).toBe("loading");
    expect(sourceState({ hasData: false, failed: true })).toBe("failed");
    expect(sourceState({ hasData: true, failed: false })).toBe("ready");
    expect(sourceState({ hasData: true, failed: true })).toBe("refresh_failed");
    expect(["loading", "failed", "ready", "refresh_failed"].map((s) => hasSourceData(s as SourceState))).toEqual([false, false, true, true]);
  });
});

describe("pageAvailability", () => {
  it("waits for the main data, then for its context", () => {
    expect(pageAvailability({ main: "loading", context: "ready" })).toEqual({ kind: "loading" });
    expect(pageAvailability({ main: "loading", context: "failed", fallback: "failed" })).toEqual({ kind: "loading" });
    // Sessions in, hosts still loading: don't flash every status as untrusted.
    expect(pageAvailability({ main: "ready", context: "loading" })).toEqual({ kind: "loading" });
  });

  it("shows the main data when its context failed, and says so", () => {
    expect(pageAvailability({ main: "ready", context: "failed" })).toEqual({ kind: "shown", contextMissing: true });
    expect(pageAvailability({ main: "refresh_failed", context: "failed" })).toEqual({ kind: "shown", contextMissing: true });
    expect(pageAvailability({ main: "ready", context: "ready" })).toEqual({ kind: "shown", contextMissing: false });
    expect(pageAvailability({ main: "ready" })).toEqual({ kind: "shown", contextMissing: false });
  });

  it("keeps data whose refresh failed, for the main data and its context", () => {
    expect(pageAvailability({ main: "refresh_failed", context: "ready" })).toEqual({ kind: "shown", contextMissing: false });
    expect(pageAvailability({ main: "ready", context: "refresh_failed" })).toEqual({ kind: "shown", contextMissing: false });
  });

  it("falls back to other data when the main data failed, and fails only when nothing is left", () => {
    expect(pageAvailability({ main: "failed", fallback: "ready" })).toEqual({ kind: "main_missing" });
    expect(pageAvailability({ main: "failed", fallback: "refresh_failed" })).toEqual({ kind: "main_missing" });
    expect(pageAvailability({ main: "failed", fallback: "loading" })).toEqual({ kind: "main_missing" });
    expect(pageAvailability({ main: "failed", fallback: "failed" })).toEqual({ kind: "failed" });
    // No fallback: the main data was all there was.
    expect(pageAvailability({ main: "failed", context: "ready" })).toEqual({ kind: "failed" });
  });
});

describe("refreshFailure", () => {
  it("is null while nothing failed to refresh, including first-load failures", () => {
    expect(
      refreshFailure([
        { source: "sessions", state: "ready", fetchedAt: 1 },
        { source: "hosts", state: "failed", fetchedAt: 0 },
      ]),
    ).toBeNull();
  });

  it("names every list that failed to refresh, from its oldest data", () => {
    expect(
      refreshFailure([
        { source: "sessions", state: "refresh_failed", fetchedAt: 5_000 },
        { source: "hosts", state: "refresh_failed", fetchedAt: 2_000 },
      ]),
    ).toEqual({ sources: ["sessions", "hosts"], dataFrom: 2_000 });
    expect(refreshFailure([{ source: "hosts", state: "refresh_failed", fetchedAt: 0 }])).toEqual({ sources: ["hosts"], dataFrom: null });
  });
});

describe("syncWithRefreshes", () => {
  it("makes current data stale once a refresh fails, and leaves what the banner says alone", () => {
    expect(syncWithRefreshes("current", ["ready", "ready"])).toBe("current");
    expect(syncWithRefreshes("current", ["ready", "refresh_failed"])).toBe("stale");
    expect(syncWithRefreshes("offline", ["refresh_failed"])).toBe("offline");
    expect(syncWithRefreshes("unreachable", ["ready"])).toBe("unreachable");
    // A first-load failure has nothing on screen to mark.
    expect(syncWithRefreshes("current", ["failed"])).toBe("current");
  });
});

describe("buildSessionViews without a host list", () => {
  const sessions = [session("approval", "laptop", "approval_required"), session("running", "laptop", "running"), session("done", "desktop", "ended")];

  it("shows each session's last reported status, never a derived disconnected or source state", () => {
    const views = buildSessionViews(sessions, null, now, CURRENT);
    expect(views.map((v) => [v.id, v.displayStatus])).toEqual([
      ["approval", "approval_required"],
      ["running", "running"],
      ["done", "ended"],
    ]);
    expect(countByState(views).byState.disconnected).toBe(0);
    expect(views.every((v) => v.hostConnectivity === null && v.hostName === HOST_NOT_LOADED_NAME)).toBe(true);
  });

  it("marks every session stale because its host status couldn't be loaded", () => {
    const [v] = buildSessionViews(sessions, null, now, CURRENT);
    expect(v?.freshness).toEqual({ lastReadAt: now.toISOString(), stale: true, reason: "hosts_unavailable" });
    expect(STALE_REASON_LABEL.hosts_unavailable).toBe("Host status couldn't be loaded");
    expect(untrustedHostReason(null, HOST_NOT_LOADED_NAME)).toBe("This session's host couldn't be loaded");
  });

  it("lets the client's own reason win while it isn't current", () => {
    const [v] = buildSessionViews(sessions, null, now, { ...CURRENT, sync: "offline" });
    expect(v?.freshness.reason).toBe("client_offline");
  });
});

describe("statusIndicator", () => {
  it("says Connected only while the banner and every status list agree", () => {
    expect(statusIndicator({ kind: "current" }, ["ready", "ready"]).tone).toBe("ok");
    // First loads still running don't count against it: the pages show their own loading state.
    expect(statusIndicator({ kind: "current" }, ["loading", "ready"]).tone).toBe("ok");
    expect(statusIndicator({ kind: "current" }, ["ready", "refresh_failed"])).toMatchObject({ tone: "warn", text: "Not refreshing" });
    expect(statusIndicator({ kind: "current" }, ["ready", "failed"])).toMatchObject({ tone: "warn", text: "Incomplete" });
  });

  it("leaves anything the banner reports to the banner's own wording", () => {
    expect(statusIndicator({ kind: "offline", dataFrom: null }, ["refresh_failed"]).text).toBe("Offline");
    expect(statusIndicator({ kind: "unreachable", dataFrom: 1, cause: "paused" }, ["failed"]).text).toBe("Paused");
  });
});
