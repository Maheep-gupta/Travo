import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SessionUpsert, type HeartbeatInput, type ProviderId } from "@mc/contracts";
import type { EventInput, KnownSession, MessageInput, Transport } from "../types.js";
import type { HostCredentials } from "../credentials.js";

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
  ) {
    this.backendUrl = url;
    this.client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: true },
    });
  }

  private async ensureSignedIn(): Promise<void> {
    if (this.signedIn) {
      const { data } = await this.client.auth.getSession();
      if (data.session) return;
    }
    const { error } = await this.client.auth.signInWithPassword({ email: this.creds.email, password: this.creds.password });
    if (error) throw new Error(`host sign-in failed (${error.status ?? "network"}); the host may have been revoked`);
    this.signedIn = true;
  }

  async heartbeat(input: HeartbeatInput): Promise<void> {
    await this.ensureSignedIn();
    const { error } = await this.client.rpc("host_heartbeat", {
      p_platform: input.platform,
      p_connector_version: input.connector_version,
      p_remote_control_allowed: input.remote_control_allowed,
    });
    if (error) throw new Error(`heartbeat failed (${error.code})`);
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
    if (error) throw new Error(`insert messages failed (${error.code})`);
  }
}
