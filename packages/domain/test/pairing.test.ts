import { describe, expect, it } from "vitest";
import type { HostRow } from "@mc/contracts";
import { PAIRING_POLL_GRACE_MS, PAIRING_POLL_MS, pairingPollInterval, pairingStatus } from "../src/index.js";
import { host, now } from "./fixtures.js";

describe("pairing confirmation", () => {
  const ticket = { expires_at: new Date(now.getTime() + 10 * 60_000).toISOString() };
  const fresh = (patch: Partial<HostRow>): HostRow => ({ ...host("new", null), ...patch });

  it("only reports connected once the host has heartbeated", () => {
    expect(pairingStatus(ticket, undefined, now)).toBe("waiting");
    expect(pairingStatus(ticket, fresh({}), now)).toBe("waiting");
    expect(pairingStatus(ticket, fresh({ paired_at: now.toISOString() }), now)).toBe("paired");
    expect(pairingStatus(ticket, fresh({ paired_at: now.toISOString(), last_seen_at: now.toISOString() }), now)).toBe("connected");
  });

  it("is honest about stopped, expired and revoked hosts", () => {
    expect(pairingStatus(ticket, host("new", 10 * 60_000), now)).toBe("stopped");
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(pairingStatus(ticket, fresh({}), later)).toBe("expired");
    // A code used in time is not "expired" just because the first heartbeat is late.
    expect(pairingStatus(ticket, fresh({ paired_at: now.toISOString() }), later)).toBe("paired");
    expect(pairingStatus(ticket, fresh({ revoked_at: now.toISOString() }), now)).toBe("revoked");
  });

  it("never reports an unparseable expiry as expired", () => {
    expect(pairingStatus({ expires_at: "garbage" }, undefined, now)).toBe("waiting");
  });

  it("polls only while waiting, and stops a while after the code expires", () => {
    expect(pairingPollInterval("waiting", ticket, now)).toBe(PAIRING_POLL_MS);
    expect(pairingPollInterval("paired", ticket, now)).toBe(PAIRING_POLL_MS);
    for (const done of ["connected", "stopped", "expired", "revoked"] as const) expect(pairingPollInterval(done, ticket, now)).toBe(false);
    const expiry = Date.parse(ticket.expires_at);
    expect(pairingPollInterval("paired", ticket, new Date(expiry + PAIRING_POLL_GRACE_MS))).toBe(PAIRING_POLL_MS);
    expect(pairingPollInterval("paired", ticket, new Date(expiry + PAIRING_POLL_GRACE_MS + 1))).toBe(false);
    expect(pairingPollInterval("waiting", { expires_at: "garbage" }, now)).toBe(false);
  });
});
