import { DISCONNECT_AFTER_MS, hostConnectivity, hostSourceOk, type HostConnectivityInput } from "./hosts.js";
import { relativeTime } from "./time.js";

/**
 * How current a host's or session's data is: when its session source was last
 * read successfully. This is separate from "last activity" (when the session
 * itself last did something); a quiet session can be perfectly up to date.
 *
 * Derived from existing fields only. The connector heartbeats right after each
 * successful read and upserts every observed session on each poll, so:
 * - host online, source OK: read at the latest heartbeat (or session write);
 * - source failing: the last good read was no later than provider_error_since;
 * - host offline or revoked: no later than its last heartbeat.
 * Anything but "online with a working source" is stale; staleness reuses the
 * connectivity thresholds in hosts.ts rather than adding new ones.
 *
 * The client's own copy can be old too (offline, backend unreachable, a
 * silently dropped realtime channel): withClientRead caps the result at the
 * client's last successful fetch and gives it a client-side reason, so a
 * cached state is never shown as current and a healthy host isn't blamed.
 * "hosts_unavailable" is client-side as well: the session list loaded but the
 * host list didn't, so nothing is known about the host (spec 3.5 partial data).
 */
export type FreshnessReason =
  | "current"
  | "source_failing"
  | "host_offline"
  | "revoked"
  | "never_connected"
  | "host_unknown"
  | "hosts_unavailable"
  | "client_offline"
  | "client_unreachable"
  | "client_not_refreshed";

export interface Freshness {
  /** Best upper bound for the last successful source read; null if there never was one. Never in the future. */
  lastReadAt: string | null;
  stale: boolean;
  reason: FreshnessReason;
}

export interface FreshnessHostInput extends HostConnectivityInput {
  provider_error_since: string | null;
}

/** Short text for the stale marker; never conveyed by colour alone. */
export const STALE_REASON_LABEL: Record<Exclude<FreshnessReason, "current">, string> = {
  source_failing: "Source not responding",
  host_offline: "Host offline",
  revoked: "Host revoked",
  never_connected: "Never connected",
  host_unknown: "Host not listed",
  hosts_unavailable: "Host status couldn't be loaded",
  client_offline: "Not refreshed — you're offline",
  client_unreachable: "Not refreshed — can't reach the backend",
  client_not_refreshed: "Not refreshed recently",
};

/**
 * A client copy older than this is no longer presented as current: three
 * missed 30 s polls, the same budget after which a host counts as disconnected.
 */
export const STALE_DATA_AFTER_MS = DISCONNECT_AFTER_MS;

/** Whether the client is keeping its copy up to date; the same states as the app's offline banner. */
export type ClientSync = "current" | "offline" | "unreachable" | "stale";

export interface ClientRead {
  sync: ClientSync;
  /** When the client last fetched the data shown (epoch ms); null if it never did. */
  fetchedAt: number | null;
}

const CLIENT_REASON: Record<Exclude<ClientSync, "current">, FreshnessReason> = {
  offline: "client_offline",
  unreachable: "client_unreachable",
  stale: "client_not_refreshed",
};

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Latest valid time, capped at `cap` (source failure start) and at now (clock skew). */
function lastRead(candidates: readonly (string | null | undefined)[], cap: string | null, now: Date): string | null {
  let best: number | null = null;
  for (const c of candidates) {
    const t = parse(c);
    if (t !== null && (best === null || t > best)) best = t;
  }
  if (best === null) return null;
  const capAt = parse(cap);
  if (capAt !== null && capAt < best) best = capAt;
  return new Date(Math.min(best, now.getTime())).toISOString();
}

function freshness(host: FreshnessHostInput, extra: string | null, now: Date): Freshness {
  const connectivity = hostConnectivity(host, now);
  const sourceOk = hostSourceOk(host);
  const at = lastRead([host.last_seen_at, extra], sourceOk ? null : host.provider_error_since, now);
  if (connectivity === "never_connected") return { lastReadAt: parse(extra) === null ? null : at, stale: true, reason: "never_connected" };
  if (connectivity === "revoked") return { lastReadAt: at, stale: true, reason: "revoked" };
  if (connectivity === "disconnected") return { lastReadAt: at, stale: true, reason: "host_offline" };
  if (!sourceOk) return { lastReadAt: at, stale: true, reason: "source_failing" };
  return { lastReadAt: at, stale: false, reason: "current" };
}

/** Freshness of everything a host reports. */
export function hostFreshness(host: FreshnessHostInput, now: Date): Freshness {
  return freshness(host, null, now);
}

/**
 * Freshness of one session. Its row's updated_at is refreshed on every
 * successful poll that still lists it, so it can be newer than the last
 * heartbeat. A session whose host is missing is always stale.
 */
export function sessionFreshness(session: { updated_at: string }, host: FreshnessHostInput | undefined, now: Date): Freshness {
  if (!host) return { lastReadAt: lastRead([session.updated_at], null, now), stale: true, reason: "host_unknown" };
  return freshness(host, session.updated_at, now);
}

/**
 * Caps a host-side freshness at the client's last successful fetch of the data
 * on screen. While the client isn't current, or that fetch is older than
 * STALE_DATA_AFTER_MS, the data is stale for a client-side reason that
 * replaces the host one: the host may be fine, we just can't see it.
 */
export function withClientRead(f: Freshness, client: ClientRead, now: Date): Freshness {
  const fetchedAt = client.fetchedAt !== null && client.fetchedAt > 0 ? client.fetchedAt : null;
  const read = parse(f.lastReadAt);
  const lastReadAt = read !== null && fetchedAt !== null && fetchedAt < read ? new Date(fetchedAt).toISOString() : f.lastReadAt;
  if (client.sync !== "current") return { lastReadAt, stale: true, reason: CLIENT_REASON[client.sync] };
  if (fetchedAt === null || now.getTime() - fetchedAt > STALE_DATA_AFTER_MS) return { lastReadAt, stale: true, reason: "client_not_refreshed" };
  return { ...f, lastReadAt };
}

/**
 * When to judge host connectivity. While the client is current that is now,
 * so a host that goes quiet between polls is noticed. Otherwise it is when the
 * host list was fetched: a cached last_seen_at ageing on a phone that can't
 * refresh says nothing about the host itself.
 */
export function connectivityJudgedAt(sync: ClientSync, hostsFetchedAt: number | null, now: Date): Date {
  if (sync === "current" || hostsFetchedAt === null || hostsFetchedAt <= 0) return now;
  return new Date(Math.min(hostsFetchedAt, now.getTime()));
}

/** "Updated 5m ago" / "Never updated". Pair with STALE_REASON_LABEL when stale. */
export function freshnessLabel(f: Freshness, now: Date): string {
  return f.lastReadAt ? `Updated ${relativeTime(f.lastReadAt, now)}` : "Never updated";
}
