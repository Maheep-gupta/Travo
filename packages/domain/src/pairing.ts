import type { HostRow, PairingTicket } from "@mc/contracts";
import { hostConnectivity } from "./hosts.js";

/**
 * Pairing confirmation (spec 11.3): a created code proves nothing, so success
 * is only claimed once the new host has actually heartbeated.
 * - waiting: code not used yet (or the host list hasn't caught up);
 * - paired: the connector exchanged the code but hasn't heartbeated yet;
 * - connected: heartbeating now;
 * - stopped: it heartbeated, but has since stopped reporting;
 * - expired: the code expired unused; revoked: access was revoked meanwhile.
 */
export type PairingStatus = "waiting" | "paired" | "connected" | "stopped" | "expired" | "revoked";

export type PairingHostInput = Pick<HostRow, "last_seen_at" | "revoked_at" | "paired_at">;

export function pairingStatus(ticket: Pick<PairingTicket, "expires_at">, host: PairingHostInput | undefined, now: Date): PairingStatus {
  if (host) {
    const connectivity = hostConnectivity(host, now);
    if (connectivity === "revoked") return "revoked";
    if (connectivity === "online") return "connected";
    if (connectivity === "disconnected") return "stopped";
    if (host.paired_at) return "paired";
  }
  const expires = Date.parse(ticket.expires_at);
  return !Number.isNaN(expires) && now.getTime() > expires ? "expired" : "waiting";
}

export const PAIRING_POLL_MS = 3_000;
/** Polling stops this long after the code expires, so an abandoned screen doesn't poll forever. */
export const PAIRING_POLL_GRACE_MS = 5 * 60_000;

/** How often to re-read hosts while confirming a pairing, or false to stop. */
export function pairingPollInterval(status: PairingStatus, ticket: Pick<PairingTicket, "expires_at">, now: Date): number | false {
  if (status !== "waiting" && status !== "paired") return false;
  const expires = Date.parse(ticket.expires_at);
  if (Number.isNaN(expires)) return false;
  return now.getTime() <= expires + PAIRING_POLL_GRACE_MS ? PAIRING_POLL_MS : false;
}
