import type { HostRow, SessionRow } from "@mc/contracts";
import { connectivityJudgedAt, hostFreshness, sessionFreshness, withClientRead, type ClientSync, type Freshness } from "./freshness.js";
import { displayStatus, hostConnectivity, hostSourceOk, type HostConnectivity } from "./hosts.js";
import { compareByAttention } from "./sessions.js";
import type { DisplayStatus } from "./status.js";

/** Shown for a session whose host is no longer in the host list. */
export const UNKNOWN_HOST_NAME = "Unknown host";

export interface SessionView extends SessionRow {
  displayStatus: DisplayStatus;
  hostName: string;
  hostConnectivity: HostConnectivity;
  /** When this session's source was last read successfully; separate from last activity. */
  freshness: Freshness;
}

/** How current the client's copy is and when each list was last fetched (epoch ms; 0 or null = never). */
export interface ClientState {
  sync: ClientSync;
  sessionsFetchedAt: number | null;
  hostsFetchedAt: number | null;
}

/**
 * Joins sessions with their hosts and applies the connectivity rules.
 * Connectivity is judged when the host list was fetched while the client isn't
 * current, so a phone that can't refresh doesn't report healthy hosts as
 * offline; freshness is then capped at the session list's own fetch.
 */
export function buildSessionViews(sessions: readonly SessionRow[], hosts: readonly HostRow[], now: Date, client: ClientState): SessionView[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const judgedAt = connectivityJudgedAt(client.sync, client.hostsFetchedAt, now);
  const read = { sync: client.sync, fetchedAt: client.sessionsFetchedAt };
  return sessions
    .map((s) => {
      const host = byId.get(s.host_id);
      const connectivity: HostConnectivity = host ? hostConnectivity(host, judgedAt) : "disconnected";
      return {
        ...s,
        displayStatus: displayStatus(s.status, connectivity, host ? hostSourceOk(host) : true),
        hostName: host?.name ?? UNKNOWN_HOST_NAME,
        hostConnectivity: connectivity,
        freshness: withClientRead(sessionFreshness(s, host, judgedAt), read, now),
      };
    })
    .sort(compareByAttention);
}

export interface HostView {
  connectivity: HostConnectivity;
  freshness: Freshness;
}

/** One host's connectivity and freshness, judged like buildSessionViews; `fetchedAt` is the host list's. */
export function buildHostView(host: HostRow, now: Date, client: { sync: ClientSync; fetchedAt: number | null }): HostView {
  const judgedAt = connectivityJudgedAt(client.sync, client.fetchedAt, now);
  return { connectivity: hostConnectivity(host, judgedAt), freshness: withClientRead(hostFreshness(host, judgedAt), client, now) };
}

/** Why a "disconnected" session's host can't be trusted; never claims more than is known. */
export function untrustedHostReason(connectivity: HostConnectivity, hostName: string): string {
  switch (connectivity) {
    case "revoked":
      return `${hostName} was revoked and no longer reports`;
    case "never_connected":
      return `${hostName} has never reported`;
    case "online":
    case "disconnected":
      return hostName === UNKNOWN_HOST_NAME ? "This session's host is no longer listed" : `${hostName} has stopped reporting`;
  }
}
