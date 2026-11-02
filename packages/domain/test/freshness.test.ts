import { describe, expect, it } from "vitest";
import {
  DISCONNECT_AFTER_MS,
  STALE_DATA_AFTER_MS,
  STALE_REASON_LABEL,
  connectivityJudgedAt,
  freshnessLabel,
  hostFreshness,
  sessionFreshness,
  withClientRead,
  type FreshnessHostInput,
} from "../src/index.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const host = (patch: Partial<FreshnessHostInput> = {}): FreshnessHostInput => ({
  last_seen_at: ago(10_000),
  provider_error_since: null,
  revoked_at: null,
  ...patch,
});

describe("hostFreshness", () => {
  it("is current at the latest heartbeat while online with a working source", () => {
    expect(hostFreshness(host(), NOW)).toEqual({ lastReadAt: ago(10_000), stale: false, reason: "current" });
  });

  it("caps the last good read at provider_error_since while the source fails", () => {
    const f = hostFreshness(host({ provider_error_since: ago(5 * 60_000) }), NOW);
    expect(f).toEqual({ lastReadAt: ago(5 * 60_000), stale: true, reason: "source_failing" });
    expect(freshnessLabel(f, NOW)).toBe("Updated 5m ago");
  });

  it("is stale at the last heartbeat once the host stops reporting", () => {
    expect(hostFreshness(host({ last_seen_at: ago(DISCONNECT_AFTER_MS + 1) }), NOW)).toEqual({
      lastReadAt: ago(DISCONNECT_AFTER_MS + 1),
      stale: true,
      reason: "host_offline",
    });
    // Exactly at the threshold is still online, as in hostConnectivity.
    expect(hostFreshness(host({ last_seen_at: ago(DISCONNECT_AFTER_MS) }), NOW).stale).toBe(false);
  });

  it("uses the earlier of heartbeat and failure start when offline with a failing source", () => {
    const f = hostFreshness(host({ last_seen_at: ago(3_600_000), provider_error_since: ago(7_200_000) }), NOW);
    expect(f).toMatchObject({ lastReadAt: ago(7_200_000), reason: "host_offline", stale: true });
  });

  it("has no read at all for a host that never connected", () => {
    const f = hostFreshness(host({ last_seen_at: null }), NOW);
    expect(f).toEqual({ lastReadAt: null, stale: true, reason: "never_connected" });
    expect(freshnessLabel(f, NOW)).toBe("Never updated");
  });

  it("is stale for a revoked host even if it heartbeated recently", () => {
    expect(hostFreshness(host({ revoked_at: ago(1_000) }), NOW)).toEqual({ lastReadAt: ago(10_000), stale: true, reason: "revoked" });
  });

  it("never reports a read in the future (clock skew)", () => {
    const f = hostFreshness(host({ last_seen_at: new Date(NOW.getTime() + 60_000).toISOString() }), NOW);
    expect(f).toEqual({ lastReadAt: NOW.toISOString(), stale: false, reason: "current" });
    expect(freshnessLabel(f, NOW)).toBe("Updated just now");
  });

  it("treats an unparseable heartbeat as no read and stale", () => {
    expect(hostFreshness(host({ last_seen_at: "not a date" }), NOW)).toEqual({ lastReadAt: null, stale: true, reason: "host_offline" });
  });
});

describe("sessionFreshness", () => {
  it("uses the session's own write when it is newer than the heartbeat", () => {
    expect(sessionFreshness({ updated_at: ago(2_000) }, host(), NOW)).toEqual({ lastReadAt: ago(2_000), stale: false, reason: "current" });
  });

  it("uses the heartbeat when the session row is older (e.g. an ended session)", () => {
    expect(sessionFreshness({ updated_at: ago(86_400_000) }, host(), NOW).lastReadAt).toBe(ago(10_000));
  });

  it("never presents data as newer than the source failure", () => {
    const f = sessionFreshness({ updated_at: ago(1_000) }, host({ provider_error_since: ago(120_000) }), NOW);
    expect(f).toEqual({ lastReadAt: ago(120_000), stale: true, reason: "source_failing" });
  });

  it("is stale when the host is offline, revoked or missing", () => {
    expect(sessionFreshness({ updated_at: ago(3_600_000) }, host({ last_seen_at: ago(3_600_000) }), NOW).reason).toBe("host_offline");
    expect(sessionFreshness({ updated_at: ago(1_000) }, host({ revoked_at: ago(500) }), NOW).reason).toBe("revoked");
    expect(sessionFreshness({ updated_at: ago(60_000) }, undefined, NOW)).toEqual({ lastReadAt: ago(60_000), stale: true, reason: "host_unknown" });
  });

  it("clamps a future session write to now", () => {
    expect(sessionFreshness({ updated_at: new Date(NOW.getTime() + 5_000).toISOString() }, host(), NOW).lastReadAt).toBe(NOW.toISOString());
  });
});

describe("withClientRead", () => {
  const current = hostFreshness(host({ last_seen_at: ago(5_000) }), NOW);

  it("keeps a current host freshness while the client fetched it recently", () => {
    expect(withClientRead(current, { sync: "current", fetchedAt: NOW.getTime() - 3_000 }, NOW)).toEqual(current);
  });

  it("never shows a read newer than the client's own fetch", () => {
    const f = withClientRead(current, { sync: "current", fetchedAt: NOW.getTime() - 60_000 }, NOW);
    expect(f).toEqual({ lastReadAt: ago(60_000), stale: false, reason: "current" });
  });

  it("is stale for a client-side reason once the client's fetch is too old", () => {
    // A fresh-looking session list that simply stopped refreshing (dropped realtime, failing query).
    const read = NOW.getTime() - STALE_DATA_AFTER_MS - 1;
    expect(withClientRead(current, { sync: "current", fetchedAt: read }, NOW)).toEqual({ lastReadAt: ago(STALE_DATA_AFTER_MS + 1), stale: true, reason: "client_not_refreshed" });
    expect(withClientRead(current, { sync: "current", fetchedAt: NOW.getTime() - STALE_DATA_AFTER_MS }, NOW).stale).toBe(false);
    expect(withClientRead(current, { sync: "current", fetchedAt: null }, NOW).reason).toBe("client_not_refreshed");
  });

  it("is stale with the client's reason, replacing the host's, while the client isn't current", () => {
    const fetchedAt = NOW.getTime() - 20_000;
    expect(withClientRead(current, { sync: "offline", fetchedAt }, NOW)).toEqual({ lastReadAt: ago(20_000), stale: true, reason: "client_offline" });
    expect(withClientRead(current, { sync: "unreachable", fetchedAt }, NOW).reason).toBe("client_unreachable");
    expect(withClientRead(current, { sync: "stale", fetchedAt }, NOW).reason).toBe("client_not_refreshed");
    const failing = hostFreshness(host({ provider_error_since: ago(60_000) }), NOW);
    expect(withClientRead(failing, { sync: "offline", fetchedAt }, NOW)).toEqual({ lastReadAt: ago(60_000), stale: true, reason: "client_offline" });
  });

  it("labels every client reason as not refreshed", () => {
    expect(STALE_REASON_LABEL.client_offline).toBe("Not refreshed — you're offline");
    expect(STALE_REASON_LABEL.client_unreachable).toBe("Not refreshed — can't reach the backend");
    expect(STALE_REASON_LABEL.client_not_refreshed).toBe("Not refreshed recently");
  });

  it("uses the heartbeat threshold", () => {
    expect(STALE_DATA_AFTER_MS).toBe(DISCONNECT_AFTER_MS);
  });
});

describe("connectivityJudgedAt", () => {
  const fetchedAt = NOW.getTime() - 10 * 60_000;

  it("judges at now while the client is current", () => {
    expect(connectivityJudgedAt("current", fetchedAt, NOW)).toEqual(NOW);
  });

  it("judges at the host list's fetch time otherwise, so a healthy host isn't called offline", () => {
    for (const sync of ["offline", "unreachable", "stale"] as const) expect(connectivityJudgedAt(sync, fetchedAt, NOW)).toEqual(new Date(fetchedAt));
    const h = host({ last_seen_at: new Date(fetchedAt - 5_000).toISOString() });
    expect(hostFreshness(h, connectivityJudgedAt("offline", fetchedAt, NOW)).reason).toBe("current");
    expect(hostFreshness(h, NOW).reason).toBe("host_offline");
  });

  it("falls back to now without a fetch time, and never judges in the future", () => {
    expect(connectivityJudgedAt("offline", null, NOW)).toEqual(NOW);
    expect(connectivityJudgedAt("offline", 0, NOW)).toEqual(NOW);
    expect(connectivityJudgedAt("offline", NOW.getTime() + 5_000, NOW)).toEqual(NOW);
  });
});
