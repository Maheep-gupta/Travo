import type { SessionStatus } from "@mc/contracts";
import type { DisplayStatus } from "./status.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Three missed heartbeats before we call a host disconnected. */
export const DISCONNECT_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

export type HostConnectivity = "online" | "disconnected" | "never_connected" | "revoked";

export interface HostConnectivityInput {
  last_seen_at: string | null;
  revoked_at: string | null;
}

export function hostConnectivity(host: HostConnectivityInput, now: Date): HostConnectivity {
  if (host.revoked_at) return "revoked";
  if (!host.last_seen_at) return "never_connected";
  const age = now.getTime() - Date.parse(host.last_seen_at);
  return age <= DISCONNECT_AFTER_MS ? "online" : "disconnected";
}

/**
 * A session's stored status is only trustworthy while its host is online.
 * Ended sessions stay ended; everything else becomes "disconnected".
 */
export function displayStatus(status: SessionStatus, connectivity: HostConnectivity): DisplayStatus {
  if (connectivity === "online" || status === "ended") return status;
  return "disconnected";
}
