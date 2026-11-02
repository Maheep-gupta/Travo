import type { HostRow, SessionRow } from "@mc/contracts";
import type { ClientState } from "../src/index.js";

export const now = new Date("2026-10-29T12:00:00Z");

/** A host that last heartbeated `lastSeenAgoMs` before `now` (null = never). */
export const host = (id: string, lastSeenAgoMs: number | null): HostRow => ({
  id,
  owner_id: "00000000-0000-4000-8000-000000000001",
  name: id,
  platform: null,
  connector_version: null,
  remote_control_allowed: false,
  last_seen_at: lastSeenAgoMs === null ? null : new Date(now.getTime() - lastSeenAgoMs).toISOString(),
  provider_error_since: null,
  paired_at: null,
  revoked_at: null,
  created_at: now.toISOString(),
});

export const session = (id: string, hostId: string, status: SessionRow["status"]): SessionRow => ({
  id,
  owner_id: "00000000-0000-4000-8000-000000000001",
  host_id: hostId,
  provider: "mock",
  external_id: id,
  title: id,
  project_label: null,
  status,
  status_reason: null,
  status_source: "mock",
  last_activity_at: now.toISOString(),
  last_event_summary: null,
  capabilities: [],
  is_demo: true,
  started_at: null,
  ended_at: null,
  updated_at: now.toISOString(),
});

/** A client that fetched both lists just now. */
export const CURRENT: ClientState = { sync: "current", sessionsFetchedAt: now.getTime(), hostsFetchedAt: now.getTime() };
