import type { HostRow, NotificationPrefs, PairingTicket, SessionEventRow, SessionMessageRow, SessionRow } from "@mc/contracts";
import type { SessionListGaps } from "@mc/domain";

export type BackendKind = "demo" | "supabase";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface SignOutResult {
  serverRevoked: boolean;
}

export type ChangeTopic ="sessions" | "session_events" | "hosts";

/**
 * Whether `subscribe`'s server push is working. "unavailable": the channel
 * couldn't be joined or was lost; the app's 30 s polls still keep data current.
 */
export type LiveUpdatesStatus = "connecting" | "on" | "unavailable";

/** Read-only view of the live-updates channel, for display. Carries no error details. */
export interface LiveUpdates {
  /** Null while nothing is subscribed. */
  status(): LiveUpdatesStatus | null;
  onChange(cb: () => void): () => void;
}

/**
 * What the latest session list left out, for display. A side channel (like
 * LiveUpdates) so `listSessions` keeps returning plain rows and every cache of
 * that list keeps its shape. Counts only, never row content.
 */
export interface SessionListInfo {
  /** Gaps in the latest successful `listSessions`; null before one and after sign-out. Stable until it changes. */
  gaps(): SessionListGaps | null;
  onChange(cb: () => void): () => void;
}

/**
 * The client-side contract used by the web app and, later, the React Native
 * app. Implementations must enforce nothing security-relevant themselves:
 * authorisation lives in the database (RLS) — this is only a typed wrapper.
 */
export interface TavroApi {
  readonly kind: BackendKind;

  getSchemaVersion(): Promise<number | null>;

  getUser(): Promise<AuthUser | null>;
  signIn(email: string, password: string): Promise<void>;
  /**
   * Ends the session. `localOnly` ends it on this device only (auth-js still
   * attempts a logout request and ignores 401/403/404); if that fails, the
   * stored session is removed anyway. Used once the token has expired.
   * The session always ends on this device; `serverRevoked` is false when the
   * server could not be told, so it may still consider the session active.
   */
  signOut(options?: { localOnly?: boolean }): Promise<SignOutResult>;
  /**
   * Leaves this backend (Change backend): removes this device's stored
   * sign-in for it, tells its other tabs, and stops background work. Sends
   * nothing anywhere, so a session can never reach another backend. Never
   * rejects; the instance must not be used afterwards.
   */
  close(): Promise<void>;
  onAuthChange(cb: (user: AuthUser | null) => void): () => void;

  /**
   * At most SESSION_LIST_LIMIT sessions, most recently active first. A row that
   * fails validation is left out instead of failing the list; what was left
   * out is reported through `sessionList`.
   */
  listSessions(): Promise<SessionRow[]>;
  getSession(id: string): Promise<SessionRow | null>;
  listEvents(sessionId: string, limit?: number): Promise<SessionEventRow[]>;
  listMessages(sessionId: string, limit?: number): Promise<SessionMessageRow[]>;

  listHosts(): Promise<HostRow[]>;
  createHostPairing(name: string): Promise<PairingTicket>;
  revokeHost(hostId: string): Promise<void>;

  getNotificationPrefs(): Promise<NotificationPrefs | null>;
  saveNotificationPrefs(prefs: NotificationPrefs): Promise<void>;

  /** Server-pushed change notifications. Returns an unsubscribe function. */
  subscribe(cb: (topic: ChangeTopic) => void): () => void;
  /** How the latest subscription is doing. Absent where there is no server push to fail (demo). */
  readonly liveUpdates?: LiveUpdates;
  /** What the latest session list left out. Absent where nothing reports it (test doubles): treated as complete. */
  readonly sessionList?: SessionListInfo;
}

/**
 * Errors safe to show to users (no secrets, no SQL). `misconfigured`: the
 * backend rejected the app's own key (e.g. a rotated publishable key), which
 * signing in again cannot fix.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    // "unavailable": no answer or a 5xx (network failure, timeout, CORS-blocked
    // response). "paused": the Supabase project said it is paused (HTTP 540).
    // "rate_limited": HTTP 429; retrying straight away only prolongs it.
    readonly code: "unauthorized" | "misconfigured" | "forbidden" | "not_found" | "invalid" | "unavailable" | "paused" | "rate_limited" | "unknown",
  ) {
    super(message);
    this.name = "ApiError";
  }
}
