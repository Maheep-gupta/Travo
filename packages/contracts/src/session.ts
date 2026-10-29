import { z } from "zod";

/**
 * Truthful session states. "unknown" is used whenever the integration cannot
 * tell us; we never infer completion from inactivity.
 */
export const SessionStatus = z.enum([
  "running",
  "waiting_for_input",
  "approval_required",
  "completed",
  "failed",
  "ended",
  "unknown",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Where a status value came from, so the UI can explain it. */
export const StatusSource = z.enum(["cli_agents_list", "hook", "transcript", "mock", "derived"]);
export type StatusSource = z.infer<typeof StatusSource>;

export const ProviderId = z.enum(["mock", "claude-code", "claude-desktop", "cowork", "claude-web"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const Capability = z.enum([
  "discover",
  "get_details",
  "read_messages",
  "subscribe_events",
  "send_message",
  "resume",
  "approve_requests",
]);
export type Capability = z.infer<typeof Capability>;

const isoTimestamp = z.string().datetime({ offset: true });

/** Row shape of public.sessions as returned to clients. */
export const SessionRow = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  host_id: z.string().uuid(),
  provider: ProviderId,
  external_id: z.string().min(1).max(200),
  title: z.string().max(300).nullable(),
  project_label: z.string().max(200).nullable(),
  status: SessionStatus,
  status_reason: z.string().max(500).nullable(),
  status_source: StatusSource,
  last_activity_at: isoTimestamp.nullable(),
  last_event_summary: z.string().max(500).nullable(),
  capabilities: z.array(Capability),
  is_demo: z.boolean(),
  started_at: isoTimestamp.nullable(),
  ended_at: isoTimestamp.nullable(),
  updated_at: isoTimestamp,
});
export type SessionRow = z.infer<typeof SessionRow>;

/** What a connector reports about a session; ownership is set server-side. */
export const SessionUpsert = SessionRow.pick({
  provider: true,
  external_id: true,
  title: true,
  project_label: true,
  status: true,
  status_reason: true,
  status_source: true,
  last_activity_at: true,
  last_event_summary: true,
  capabilities: true,
  is_demo: true,
  started_at: true,
  ended_at: true,
});
export type SessionUpsert = z.infer<typeof SessionUpsert>;

export const SessionEventType = z.enum([
  "session_discovered",
  "status_changed",
  "session_ended",
]);
export type SessionEventType = z.infer<typeof SessionEventType>;

export const SessionEventRow = z.object({
  id: z.number().int(),
  owner_id: z.string().uuid(),
  host_id: z.string().uuid(),
  session_id: z.string().uuid(),
  type: SessionEventType,
  status: SessionStatus.nullable(),
  summary: z.string().max(500).nullable(),
  dedupe_key: z.string().min(1).max(200),
  is_demo: z.boolean(),
  occurred_at: isoTimestamp,
});
export type SessionEventRow = z.infer<typeof SessionEventRow>;

export const MessageRole = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRole>;

/** Transcript excerpts. Only ever stored in a loopback (on-laptop) database. */
export const SessionMessageRow = z.object({
  id: z.number().int(),
  session_id: z.string().uuid(),
  external_uuid: z.string().min(1).max(100),
  role: MessageRole,
  text: z.string().max(4000),
  occurred_at: isoTimestamp.nullable(),
});
export type SessionMessageRow = z.infer<typeof SessionMessageRow>;
