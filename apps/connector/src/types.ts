import type { HeartbeatInput, MessageRole, ProviderId, SessionStatus, SessionUpsert } from "@mc/contracts";

/** What a provider reports about one session. Content-free. */
export interface ProviderSession {
  external_id: string;
  title: string | null;
  project_label: string | null;
  status: SessionStatus;
  status_reason: string;
  last_activity_at: string | null;
  last_event_summary: string | null;
  started_at: string | null;
}

export interface ProviderMessage {
  external_uuid: string;
  role: MessageRole;
  text: string;
  occurred_at: string | null;
}

/**
 * Why a provider read failed, so diagnostics can say which. Content-free.
 * Every category means the same thing to the backend (provider_ok = false);
 * the distinction is for logs and the connector's own diagnostics.
 */
export type ProviderFailureCategory =
  | "cli_missing"
  | "auth_required"
  | "timeout"
  | "invalid_output"
  | "incompatible_version"
  | "interrupted"
  | "failed";

export interface Provider {
  readonly id: ProviderId;
  readonly isDemo: boolean;
  poll(): Promise<ProviderSession[]>;
  /** Transcript excerpts; only called when the content guard allows it. */
  messages?(externalId: string): Promise<ProviderMessage[]>;
}

export interface EventInput {
  session_id: string;
  type: "session_discovered" | "status_changed" | "session_ended";
  status: SessionStatus;
  summary: string | null;
  dedupe_key: string;
  is_demo: boolean;
  occurred_at: string;
}

export interface MessageInput extends ProviderMessage {
  session_id: string;
}

export interface KnownSession {
  id: string;
  status: SessionStatus;
}

/** Where the connector writes. Implementations must be idempotent. */
export interface Transport {
  readonly backendUrl: string;
  heartbeat(input: HeartbeatInput): Promise<void>;
  /** Sessions previously reported by this host, keyed by provider external_id. */
  loadKnownSessions(provider: ProviderId): Promise<Map<string, KnownSession>>;
  /**
   * Upserts and returns external_id -> session id for the rows the backend
   * kept. A row whose observed_at is older than the stored one is skipped
   * (schema v3, "newer wins") and is absent from the result; that is not an error.
   */
  upsertSessions(rows: SessionUpsert[]): Promise<Map<string, string>>;
  /** Inserts events, ignoring ones whose (session_id, dedupe_key) already exists. */
  insertEvents(events: EventInput[]): Promise<void>;
  insertMessages(messages: MessageInput[]): Promise<void>;
}
