import type { HostRow, NotificationPrefs, PairingTicket, SessionEventRow, SessionMessageRow, SessionRow } from "@mc/contracts";

export type BackendKind = "demo" | "supabase";

export interface AuthUser {
  id: string;
  email: string | null;
}

export type ChangeTopic = "sessions" | "session_events" | "hosts";

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
  signOut(): Promise<void>;
  onAuthChange(cb: (user: AuthUser | null) => void): () => void;

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
}

/** Errors safe to show to users (no secrets, no SQL). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: "unauthorized" | "forbidden" | "not_found" | "invalid" | "unavailable" | "unknown",
  ) {
    super(message);
    this.name = "ApiError";
  }
}
