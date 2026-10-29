// Runtime constants with no zod dependency, so lightweight clients (demo mode,
// the web app's initial chunk) can import them without bundling zod.
import type { NotificationPrefs } from "./preferences.js";

/**
 * Database schema version this release of the contracts targets. Clients
 * refuse to run against a project whose public.app_meta.schema_version is
 * outside [MIN_SCHEMA_VERSION, MAX_SCHEMA_VERSION].
 */
export const MIN_SCHEMA_VERSION = 1;
export const MAX_SCHEMA_VERSION = 1;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  on_waiting_for_input: true,
  on_approval_required: true,
  on_completed: true,
  on_failed: true,
  on_host_disconnected: true,
  on_host_reconnected: false,
};
