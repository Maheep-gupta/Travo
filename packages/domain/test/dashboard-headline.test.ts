import { describe, expect, it } from "vitest";
import { countByState, countsAsOf, dashboardHeadline, trustedHostCount, type DisplayStatus, type HeadlineInput } from "../src/index.js";
import { host, now } from "./fixtures.js";

const counts = (...statuses: DisplayStatus[]) => countByState(statuses.map((displayStatus) => ({ displayStatus })));
const input = (patch: Partial<HeadlineInput>): HeadlineInput => ({ counts: counts("running"), sync: "current", trustedHosts: 1, ...patch });

describe("dashboardHeadline", () => {
  it("keeps the usual copy while current with a trusted host", () => {
    expect(dashboardHeadline(input({}))).toBe("All clear. Nothing needs you.");
    expect(dashboardHeadline(input({ counts: counts("approval_required", "running") }))).toBe("1 session needs you.");
    expect(dashboardHeadline(input({ counts: counts("approval_required", "failed") }))).toBe("2 sessions need you.");
    expect(dashboardHeadline(input({ counts: counts() }))).toBe("No sessions yet");
    expect(dashboardHeadline(input({ counts: null }))).toBe("Sessions");
  });

  it("never says all clear while offline, unreachable or not refreshed", () => {
    for (const sync of ["offline", "unreachable", "stale"] as const) {
      expect(dashboardHeadline(input({ sync }))).toBe("Can't confirm right now — last known: nothing needs you.");
      expect(dashboardHeadline(input({ sync, counts: counts("waiting_for_input") }))).toBe("Can't confirm right now — last known: 1 session needs you.");
      expect(dashboardHeadline(input({ sync, counts: counts("failed", "failed", "running") }))).toBe(
        "Can't confirm right now — last known: 2 sessions need you.",
      );
      expect(dashboardHeadline(input({ sync, counts: counts() }))).toBe("Can't confirm right now — last known: no sessions.");
    }
  });

  it("says statuses can't be confirmed when no host is trusted, or host status is missing", () => {
    expect(dashboardHeadline(input({ trustedHosts: 0, counts: counts("disconnected") }))).toBe(
      "Statuses can't be confirmed — no host is reporting normally.",
    );
    expect(dashboardHeadline(input({ trustedHosts: null, counts: counts("approval_required") }))).toBe(
      "Statuses can't be confirmed — last reported: 1 session needs you.",
    );
  });

  it("never says all clear while some sessions sit on untrusted hosts, even with another host trusted", () => {
    expect(dashboardHeadline(input({ counts: counts("running", "disconnected") }))).toBe("Nothing confirmed needs you — 1 session can't be confirmed.");
    expect(dashboardHeadline(input({ counts: counts("completed", "source_unavailable", "unknown", "disconnected") }))).toBe(
      "Nothing confirmed needs you — 3 sessions can't be confirmed.",
    );
    // What does need the user is still said as it is.
    expect(dashboardHeadline(input({ counts: counts("failed", "disconnected") }))).toBe("1 session needs you.");
  });
});

describe("trustedHostCount", () => {
  const client = { sync: "current" as const, fetchedAt: now.getTime() };

  it("counts only online hosts whose source answers", () => {
    const failing = { ...host("failing", 1000), provider_error_since: now.toISOString() };
    const revoked = { ...host("revoked", 1000), revoked_at: now.toISOString() };
    expect(trustedHostCount([host("online", 1000), host("offline", 10 * 60_000), host("never", null), failing, revoked], now, client)).toBe(1);
    expect(trustedHostCount([host("offline", 10 * 60_000)], now, client)).toBe(0);
    expect(trustedHostCount(null, now, client)).toBeNull();
  });
});

describe("countsAsOf", () => {
  it("is the banner's data time while not current, else a failed refresh's, else null", () => {
    expect(countsAsOf({ kind: "current" }, null)).toBeNull();
    expect(countsAsOf({ kind: "current" }, { sources: ["hosts"], dataFrom: 7 })).toBe(7);
    expect(countsAsOf({ kind: "offline", dataFrom: 3 }, { sources: ["hosts"], dataFrom: 7 })).toBe(3);
    expect(countsAsOf({ kind: "stale", dataFrom: 5 }, null)).toBe(5);
    expect(countsAsOf({ kind: "unreachable", dataFrom: null, cause: "paused" }, null)).toBeNull();
  });
});
