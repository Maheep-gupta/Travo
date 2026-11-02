import { describe, expect, it } from "vitest";
import { UNKNOWN_HOST_NAME, buildHostView, buildSessionViews, countByState, untrustedHostReason } from "../src/index.js";
import { CURRENT, host, now, session } from "./fixtures.js";

describe("buildSessionViews", () => {
  it("shows sessions on offline or unknown hosts as disconnected, and sorts by attention", () => {
    const views = buildSessionViews(
      [
        session("on-running", "online", "running"),
        session("off-waiting", "offline", "waiting_for_input"),
        session("orphan", "missing", "running"),
        session("on-approval", "online", "approval_required"),
      ],
      [host("online", 1000), host("offline", 10 * 60_000)],
      now,
      CURRENT,
    );
    expect(views.map((v) => [v.id, v.displayStatus])).toEqual([
      ["on-approval", "approval_required"],
      ["off-waiting", "disconnected"],
      ["orphan", "disconnected"],
      ["on-running", "running"],
    ]);
  });

  it("never shows a stale stored status behind a host whose session source is failing", () => {
    const failing = { ...host("failing", 1000), provider_error_since: new Date(now.getTime() - 60_000).toISOString() };
    const views = buildSessionViews([session("a", "failing", "running"), session("b", "failing", "ended")], [failing], now, CURRENT);
    expect(views.map((v) => [v.id, v.displayStatus])).toEqual([
      ["a", "source_unavailable"],
      ["b", "ended"],
    ]);
    expect(countByState(views).byState.source_unavailable).toBe(1);
  });

  it("names a missing host so the detail copy says it is no longer listed", () => {
    const [v] = buildSessionViews([session("orphan", "missing", "running")], [], now, CURRENT);
    expect(v?.hostName).toBe(UNKNOWN_HOST_NAME);
    expect(v && untrustedHostReason(v.hostConnectivity, v.hostName)).toBe("This session's host is no longer listed");
  });
});

describe("session freshness in views", () => {
  it("marks sessions current only while their host is online with a working source", () => {
    const failing = { ...host("failing", 1000), provider_error_since: new Date(now.getTime() - 60_000).toISOString() };
    const views = buildSessionViews(
      [session("on", "online", "running"), session("off", "offline", "running"), session("bad", "failing", "running"), session("orphan", "missing", "running")],
      [host("online", 1000), host("offline", 10 * 60_000), failing],
      now,
      CURRENT,
    );
    const byId = Object.fromEntries(views.map((v) => [v.id, v.freshness]));
    expect(byId.on).toEqual({ lastReadAt: now.toISOString(), stale: false, reason: "current" });
    expect(byId.off?.stale).toBe(true);
    expect(byId.off?.reason).toBe("host_offline");
    // Never newer than the failure start, even though the row was written later.
    expect(byId.bad).toEqual({ lastReadAt: failing.provider_error_since, stale: true, reason: "source_failing" });
    expect(byId.orphan?.reason).toBe("host_unknown");
  });

  it("goes stale when the session list stopped refreshing, even though the host list is fresh", () => {
    // A dropped realtime channel or a failing sessions query: the heartbeat says "now", the statuses don't.
    const sessionsFetchedAt = now.getTime() - 5 * 60_000;
    const [v] = buildSessionViews([session("a", "online", "running")], [host("online", 1000)], now, { ...CURRENT, sessionsFetchedAt });
    expect(v?.displayStatus).toBe("running");
    expect(v?.freshness).toEqual({ lastReadAt: new Date(sessionsFetchedAt).toISOString(), stale: true, reason: "client_not_refreshed" });
  });

  it("while the client can't refresh, keeps hosts as they were when fetched and blames the client", () => {
    const fetchedAt = now.getTime() - 10 * 60_000;
    // Heartbeated 5 s before the last fetch; ten minutes ago by the wall clock.
    const laptop = host("laptop", 10 * 60_000 + 5_000);
    for (const sync of ["offline", "unreachable", "stale"] as const) {
      const [v] = buildSessionViews([session("a", "laptop", "waiting_for_input")], [laptop], now, { sync, sessionsFetchedAt: fetchedAt, hostsFetchedAt: fetchedAt });
      expect(v?.hostConnectivity).toBe("online");
      expect(v?.displayStatus).toBe("waiting_for_input");
      expect(v?.freshness.stale).toBe(true);
      expect(v?.freshness.reason).toBe(sync === "offline" ? "client_offline" : sync === "unreachable" ? "client_unreachable" : "client_not_refreshed");
    }
    // A client that is current still notices the same host going quiet.
    expect(buildSessionViews([session("a", "laptop", "running")], [laptop], now, CURRENT)[0]?.displayStatus).toBe("disconnected");
  });
});

describe("buildHostView", () => {
  it("judges a host at its fetch time while the client can't refresh, and at now otherwise", () => {
    const fetchedAt = now.getTime() - 10 * 60_000;
    const laptop = host("laptop", 10 * 60_000 + 5_000);
    expect(buildHostView(laptop, now, { sync: "offline", fetchedAt })).toEqual({
      connectivity: "online",
      freshness: { lastReadAt: laptop.last_seen_at, stale: true, reason: "client_offline" },
    });
    expect(buildHostView(laptop, now, { sync: "current", fetchedAt: now.getTime() }).connectivity).toBe("disconnected");
    expect(buildHostView(host("fresh", 1000), now, { sync: "current", fetchedAt: now.getTime() }).freshness.reason).toBe("current");
  });
});

describe("untrustedHostReason", () => {
  it("never claims a revoked or missing host merely stopped reporting", () => {
    expect(untrustedHostReason("disconnected", "Work laptop")).toBe("Work laptop has stopped reporting");
    expect(untrustedHostReason("revoked", "Old desktop")).toBe("Old desktop was revoked and no longer reports");
    expect(untrustedHostReason("never_connected", "New laptop")).toBe("New laptop has never reported");
    expect(untrustedHostReason("disconnected", "Unknown host")).toBe("This session's host is no longer listed");
  });
});
