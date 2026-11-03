import { createClient, isAuthApiError, type SupabaseClient } from "@supabase/supabase-js";
import { SessionUpsert, type HeartbeatInput, type ProviderId } from "@mc/contracts";
import type { EventInput, KnownSession, MessageInput, Transport } from "../types.js";
import type { HostCredentials } from "../credentials.js";
import { HostAuthError, TranscriptsRefusedError } from "./errors.js";

/** Auth statuses that mean "this login is refused", not "try again shortly". */
const REJECTED_SIGN_IN: ReadonlySet<number> = new Set([400, 401, 403]);

/**
 * The API gateway refusing the `apikey` (rotated, revoked or mistyped
 * publishable key), not the host's login: a 401 whose message or hint names
 * an API key. The same rule as isKeyRejection in packages/api-client. Only
 * matched, never logged.
 */
function isKeyRejection(status: number | undefined, message: string | undefined, hint?: string | null): boolean {
  return status === 401 && /\bapi key\b/i.test(`${message ?? ""} ${hint ?? ""}`);
}

const KEY_REJECTED = "the project rejected the publishable key (401)";

/**
 * Writes to the user's Supabase project as the paired host user. Uses only
 * the publishable key + the host's own login; RLS limits it to its own rows.
 *
 * NOT YET VERIFIED against a running database (local Supabase blocked on Docker).
 */
export class SupabaseTransport implements Transport {
  readonly backendUrl: string;
  private readonly client: SupabaseClient;
  private signedIn = false;

  constructor(
    url: string,
    publishableKey: string,
    private readonly creds: HostCredentials,
    /** For tests: replaces the network. */
    fetchImpl?: typeof fetch,
  ) {
    this.backendUrl = url;
    this.client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: true },
      ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
    });
  }

  private async ensureSignedIn(): Promise<void> {
    if (this.signedIn) {
      const { data } = await this.client.auth.getSession();
      if (data.session) return;
    }
    const { error } = await this.client.auth.signInWithPassword({ email: this.creds.email, password: this.creds.password });
    if (error) {
      this.signedIn = false;
      // Auth answered and refused the login (wrong or deleted credentials, banned
      // user). Network failures, rate limits and 5xx are retryable and stay "offline".
      if (isAuthApiError(error) && isKeyRejection(error.status, error.message)) {
        throw new HostAuthError(KEY_REJECTED, "check_publishable_key");
      }
      if (isAuthApiError(error) && REJECTED_SIGN_IN.has(error.status)) {
        const code = typeof error.code === "string" && /^[a-z_]{1,40}$/.test(error.code) ? error.code : String(error.status);
        throw new HostAuthError(`host sign-in rejected (${code})`);
      }
      throw new Error(`host sign-in failed (${error.status || "network"})`);
    }
    this.signedIn = true;
  }

  async heartbeat(input: HeartbeatInput): Promise<void> {
    await this.ensureSignedIn();
    const { error, status } = await this.client.rpc("host_heartbeat", {
      p_platform: input.platform,
      p_connector_version: input.connector_version,
      p_remote_control_allowed: input.remote_control_allowed,
      p_provider_ok: input.provider_ok,
    });
    if (error) {
      // A key rotated while this connector was signed in.
      if (isKeyRejection(status, error.message, error.hint)) throw new HostAuthError(KEY_REJECTED, "check_publishable_key");
      // host_heartbeat raises 42501 when the caller is not an active host: a
      // revoked host keeps a working login, so this is where revocation shows.
      if (error.code === "42501") {
        this.signedIn = false;
        throw new HostAuthError("this host is no longer active (42501)");
      }
      throw new Error(`heartbeat failed (${error.code})`);
    }
  }

  async loadKnownSessions(provider: ProviderId): Promise<Map<string, KnownSession>> {
    await this.ensureSignedIn();
    const { data, error } = await this.client
      .from("sessions")
      .select("id, external_id, status")
      .eq("host_id", this.creds.host_id)
      .eq("provider", provider);
    if (error) throw new Error(`load sessions failed (${error.code})`);
    return new Map((data ?? []).map((r) => [r.external_id as string, { id: r.id as string, status: r.status }]));
  }

  async upsertSessions(rows: SessionUpsert[]): Promise<Map<string, string>> {
    if (rows.length === 0) return new Map();
    await this.ensureSignedIn();
    const payload = rows.map((r) => ({ ...SessionUpsert.parse(r), host_id: this.creds.host_id }));
    const { data, error } = await this.client
      .from("sessions")
      .upsert(payload, { onConflict: "host_id,provider,external_id" })
      .select("id, external_id");
    if (error) throw new Error(`upsert sessions failed (${error.code})`);
    // Rows the stale-write guard skipped (older observed_at) are not returned.
    return new Map((data ?? []).map((r) => [r.external_id as string, r.id as string]));
  }

  async insertEvents(events: EventInput[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureSignedIn();
    const { error } = await this.client
      .from("session_events")
      .upsert(events.map((e) => ({ ...e, host_id: this.creds.host_id })), { onConflict: "session_id,dedupe_key", ignoreDuplicates: true });
    if (error) throw new Error(`insert events failed (${error.code})`);
  }

  async insertMessages(messages: MessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    await this.ensureSignedIn();
    const { error } = await this.client
      .from("session_messages")
      .upsert(messages.map((m) => ({ ...m, host_id: this.creds.host_id })), { onConflict: "session_id,external_uuid", ignoreDuplicates: true });
    if (!error) return;
    // 42501 is also the owner trigger ("session does not belong to host") and
    // a revoked host's RLS, so only a confirmed setting counts as one.
    if (error.code === "42501" && (await this.transcriptsDisabled())) throw new TranscriptsRefusedError();
    throw new Error(`insert messages failed (${error.code})`);
  }

  /** True only when app_meta says transcript storage is off; false when it's on or can't be read. */
  private async transcriptsDisabled(): Promise<boolean> {
    const { data, error } = await this.client.from("app_meta").select("transcripts_enabled").limit(1);
    if (error || !Array.isArray(data) || data.length !== 1) return false;
    return (data[0] as { transcripts_enabled?: unknown }).transcripts_enabled === false;
  }
}
