import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import {
  HostRow,
  NotificationPrefs,
  PairingTicket,
  SessionEventRow,
  SessionMessageRow,
  SessionRow,
} from "@mc/contracts";
import type { z } from "zod";
import { ApiError, type AuthUser, type ChangeTopic, type TavroApi } from "./api.js";
import { ConnectionConfig } from "./connection.js";
import type { KeyValueStorage } from "./storage.js";

function toApiError(e: PostgrestError | { message?: string; code?: string; status?: number } | null): ApiError {
  const code = e && "code" in e ? e.code : undefined;
  if (code === "42501" || code === "PGRST301") return new ApiError("You are not allowed to do that.", "forbidden");
  if (code === "PGRST116") return new ApiError("Not found.", "not_found");
  if (code === "22023" || code === "23514" || code === "54000") return new ApiError(e?.message ?? "Invalid request.", "invalid");
  // Do not leak raw database messages for anything else.
  return new ApiError("The request failed. Check your connection and try again.", "unknown");
}

function parseRows<T extends z.ZodTypeAny>(schema: T, rows: unknown): z.infer<T>[] {
  return schema.array().parse(rows ?? []);
}

/**
 * Supabase-backed implementation. Uses only the publishable key plus the
 * signed-in user's JWT; every query is authorised by RLS in the database.
 */
export function createSupabaseApi(config: ConnectionConfig, storage: KeyValueStorage): TavroApi {
  const { url, publishableKey } = ConnectionConfig.parse(config);
  const client: SupabaseClient = createClient(url, publishableKey, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const toUser = (u: { id: string; email?: string | null } | null | undefined): AuthUser | null =>
    u ? { id: u.id, email: u.email ?? null } : null;

  return {
    kind: "supabase",

    async getSchemaVersion() {
      const { data, error } = await client.from("app_meta").select("schema_version").maybeSingle();
      if (error) {
        // Table missing => schema not installed.
        if (error.code === "42P01" || error.code === "PGRST205") return null;
        throw new ApiError("Could not reach the Supabase project.", "unavailable");
      }
      return (data as { schema_version: number } | null)?.schema_version ?? null;
    },

    async getUser() {
      const { data } = await client.auth.getSession();
      return toUser(data.session?.user);
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new ApiError("Sign-in failed. Check your email and password.", "unauthorized");
    },
    async signOut() {
      await client.auth.signOut();
    },
    onAuthChange(cb) {
      const { data } = client.auth.onAuthStateChange((_event, session) => cb(toUser(session?.user)));
      return () => data.subscription.unsubscribe();
    },

    async listSessions() {
      const { data, error } = await client.from("sessions").select("*").order("last_activity_at", { ascending: false }).limit(500);
      if (error) throw toApiError(error);
      return parseRows(SessionRow, data);
    },
    async getSession(id) {
      const { data, error } = await client.from("sessions").select("*").eq("id", id).maybeSingle();
      if (error) throw toApiError(error);
      return data ? SessionRow.parse(data) : null;
    },
    async listEvents(sessionId, limit = 100) {
      const { data, error } = await client
        .from("session_events")
        .select("*")
        .eq("session_id", sessionId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) throw toApiError(error);
      return parseRows(SessionEventRow, data);
    },
    async listMessages(sessionId, limit = 50) {
      const { data, error } = await client
        .from("session_messages")
        .select("id, session_id, external_uuid, role, text, occurred_at")
        .eq("session_id", sessionId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) throw toApiError(error);
      return parseRows(SessionMessageRow, data).reverse();
    },

    async listHosts() {
      const { data, error } = await client
        .from("hosts")
        .select("id, owner_id, name, platform, connector_version, remote_control_allowed, last_seen_at, paired_at, revoked_at, created_at")
        .order("created_at");
      if (error) throw toApiError(error);
      return parseRows(HostRow, data);
    },
    async createHostPairing(name) {
      const { data, error } = await client.rpc("create_host_pairing", { p_name: name });
      if (error) throw toApiError(error);
      const row = (data as unknown[] | null)?.[0];
      return PairingTicket.parse(row);
    },
    async revokeHost(hostId) {
      const { data, error } = await client.from("hosts").update({ revoked_at: new Date().toISOString() }).eq("id", hostId).select("id");
      if (error) throw toApiError(error);
      if (!data?.length) throw new ApiError("Host not found.", "not_found");
    },

    async getNotificationPrefs() {
      const { data, error } = await client
        .from("notification_prefs")
        .select("on_waiting_for_input, on_approval_required, on_completed, on_failed, on_host_disconnected, on_host_reconnected")
        .maybeSingle();
      if (error) throw toApiError(error);
      return data ? NotificationPrefs.parse(data) : null;
    },
    async saveNotificationPrefs(prefs) {
      const user = toUser((await client.auth.getSession()).data.session?.user);
      if (!user) throw new ApiError("Please sign in again.", "unauthorized");
      const { error } = await client
        .from("notification_prefs")
        .upsert({ owner_id: user.id, ...NotificationPrefs.parse(prefs), updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
      if (error) throw toApiError(error);
    },

    subscribe(cb) {
      const channel = client.channel(`mc-changes-${Math.random().toString(36).slice(2)}`);
      for (const table of ["sessions", "session_events", "hosts"] as ChangeTopic[]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, () => cb(table));
      }
      channel.subscribe();
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
