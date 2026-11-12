// Runtime constants with no zod dependency, so lightweight clients (demo mode,
// the web app's initial chunk) can import them without bundling zod.
import type { NotificationPrefs } from "./preferences.js";

/**
 * Database schema version this release of the contracts targets. Clients
 * refuse to run against a project whose public.app_meta.schema_version is
 * outside [MIN_SCHEMA_VERSION, MAX_SCHEMA_VERSION].
 */
export const MIN_SCHEMA_VERSION = 4;
export const MAX_SCHEMA_VERSION = 4;

/**
 * Why a host's session source isn't answering (schema v4,
 * hosts.provider_error_kind). Fixed categories only: no message, path or
 * command output ever crosses the wire. Must match the CHECK constraint in
 * supabase/migrations/20261112000001_provider_error_kind.sql.
 * - The first seven are the Claude Code provider's failure categories (D-025);
 *   any other provider failure is reported as "failed".
 * - "writes_not_applied": the source read fine, but the backend kept refusing
 *   or skipping this host's session writes (clock behind, or a second
 *   connector for the same host), so its statuses are frozen.
 */
export const PROVIDER_ERROR_KINDS = [
  "cli_missing",
  "auth_required",
  "timeout",
  "invalid_output",
  "incompatible_version",
  "interrupted",
  "failed",
  "writes_not_applied",
] as const;

/**
 * How far ahead of the database clock a session's observed_at may be; later
 * values are clamped to now + this. Must match the interval in
 * supabase/migrations/20261103000001_stale_write_guard.sql.
 */
export const OBSERVED_AT_MAX_SKEW_MS = 5 * 60_000;

/**
 * The most sessions one session list returns: the most recently active are
 * kept, and the client says when more exist (spec 3.1, 10.2).
 */
export const SESSION_LIST_LIMIT = 500;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  on_waiting_for_input: true,
  on_approval_required: true,
  on_completed: true,
  on_failed: true,
  on_host_disconnected: true,
  on_host_reconnected: false,
};
