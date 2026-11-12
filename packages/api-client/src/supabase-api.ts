import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import {
  HostRow,
  NotificationPrefs,
  PairingTicket,
  SessionEventRow,
  SessionMessageRow,
  SessionRow,
} from "@mc/contracts";
import { SESSION_LIST_LIMIT } from "@mc/contracts/constants";
import { POSTGREST_JWT_ERROR_CODES, isKeyRejection } from "@mc/domain";
import type { z } from "zod";
import { ACCOUNT_CHANGED_MESSAGE, ApiError, type AuthUser, type ChangeTopic, type LiveUpdatesStatus, type ReadOptions, type TavroApi } from "./api.js";
import { ConnectionConfig } from "./connection.js";
import { createSessionListStore } from "./session-list-store.js";
import { AUTH_STORAGE_PREFIX, removeKeys, removeOtherAuthSessions, type KeyValueStorage } from "./storage.js";

/** Shown whenever the database stops accepting the signed-in session. */
export const SESSION_EXPIRED_MESSAGE = "Your sign-in has expired. Please sign in again.";

// The rule itself lives in @mc/domain, shared with the connector (G32).
export { isKeyRejection };

/** Shown when the project refuses the app's publishable key; never the response text itself. */
export const KEY_REJECTED_MESSAGE = "Your Supabase project rejected this app's publishable key. If the key was rotated, choose Change backend and enter the current one.";

/**
 * Supabase's status for "the project is paused": it serves nothing until its
 * owner restores it (supabase.com/docs/guides/troubleshooting/http-status-codes).
 * A browser only sees it if that response carries CORS headers (unverified);
 * otherwise the request fails like any network error and counts as unavailable.
 */
export const PROJECT_PAUSED_STATUS = 540;

/** A session row that fails validation, when asked for on its own. */
export const SESSION_UNREADABLE_MESSAGE = "This session's data couldn't be read.";

export const RATE_LIMITED_MESSAGE = "Your Supabase project is receiving too many requests. Wait a few minutes and try again.";

export const PROJECT_PAUSED_MESSAGE ="Your Supabase project is paused. Restore it from the project's page in the Supabase dashboard, then try again.";
export const PROJECT_UNAVAILABLE_MESSAGE =
  "Could not reach your Supabase project. Check your connection and try again. A free project that hasn't been used for a while may be paused: restore it in the Supabase dashboard.";

/**
 * Whether the backend itself is unavailable rather than rejecting the request:
 * no response (status 0: network failure, timeout or a CORS-blocked answer),
 * a gateway or platform 5xx (502-504, 520+ incl. Supabase's 54x), PostgREST
 * unable to reach the database (PGRST000-003), or a 5xx without a PostgREST
 * code. A 500 that carries a database error code is a failed query, not an outage.
 */
function isUnavailable(code: string | undefined, status: number | undefined): boolean {
  if (status === 0) return true;
  if (code !== undefined && /^PGRST00\d$/.test(code)) return true;
  if (status === undefined || status < 500) return false;
  return status === 502 || status === 503 || status === 504 || status >= 520 || code === undefined;
}

/**
 * Maps a PostgREST failure to an error safe to show users. Database text and
 * response bodies are never passed through: they can name tables, columns and
 * constraints. `status` is the HTTP status of the response, when known
 * (supabase-js reports 0 when no response arrived).
 */
export function toApiError(e: Pick<PostgrestError, "code" | "message" | "hint"> | { message?: string; code?: string; hint?: string } | null, status?: number): ApiError {
  // supabase-js reports a failed fetch with code "".
  const code = e?.code || undefined;
  if (status === PROJECT_PAUSED_STATUS) return new ApiError(PROJECT_PAUSED_MESSAGE, "paused");
  if (isUnavailable(code, status)) return new ApiError(PROJECT_UNAVAILABLE_MESSAGE, "unavailable");
  if (isKeyRejection(e, status)) return new ApiError(KEY_REJECTED_MESSAGE, "misconfigured");
  // A 401 is always an authentication failure, including 42501 on a request
  // that went out anonymously because the session was already gone.
  if ((code !== undefined && POSTGREST_JWT_ERROR_CODES.has(code)) || status === 401 || /jwt expired/i.test(e?.message ?? "")) {
    return new ApiError(SESSION_EXPIRED_MESSAGE, "unauthorized");
  }
  if (status === 429) return new ApiError(RATE_LIMITED_MESSAGE, "rate_limited");
  if (code === "42501" || status === 403) return new ApiError("You are not allowed to do that.", "forbidden");
  if (code === "PGRST116") return new ApiError("Not found.", "not_found");
  if (code === "54000") return new ApiError("Too many pending pairings. Revoke unused hosts first.", "invalid");
  if (code === "22023" || code === "23514") return new ApiError("The request was rejected. Check the values and try again.", "invalid");
  // Do not leak raw database messages for anything else.
  return new ApiError("The request failed. Check your connection and try again.", "unknown");
}

/**
 * Maps a failed password sign-in. Only a genuine rejection blames the email
 * and password: an unreachable project, a rejected publishable key or a rate
 * limit would otherwise send the user round the form again. Auth's own text
 * is never shown.
 */
export function toSignInError(e: { name?: string; message?: string; code?: string; status?: number }): ApiError {
  if (e.status === PROJECT_PAUSED_STATUS) return new ApiError(PROJECT_PAUSED_MESSAGE, "paused");
  // auth-js: no response (status 0) or a gateway/server 5xx.
  if (e.name === "AuthRetryableFetchError" || e.status === undefined || e.status === 0 || e.status >= 500) {
    return new ApiError(PROJECT_UNAVAILABLE_MESSAGE, "unavailable");
  }
  if (isKeyRejection(e, e.status)) return new ApiError(KEY_REJECTED_MESSAGE, "misconfigured");
  // Not "unavailable": that is treated as transient and retried.
  if (e.status === 429) return new ApiError("Too many sign-in attempts. Wait a few minutes and try again.", "rate_limited");
  return new ApiError("Sign-in failed. Check your email and password.", "unauthorized");
}

function parseRows<T extends z.ZodTypeAny>(schema: T, rows: unknown): z.infer<T>[] {
  return schema.array().parse(rows ?? []);
}

/**
 * Validates each row on its own: a malformed row is dropped and counted, so
 * one bad row can't fail a whole list (Part 16). Only the count leaves here:
 * neither the row nor zod's issues (which quote values) are kept or logged.
 * A response that isn't a list at all still fails.
 */
export function parseEachRow<T extends z.ZodTypeAny>(schema: T, rows: unknown): { rows: z.infer<T>[]; dropped: number } {
  const all: unknown = rows ?? [];
  if (!Array.isArray(all)) throw new ApiError("The request failed. Check your connection and try again.", "unknown");
  const valid: z.infer<T>[] = [];
  for (const row of all as unknown[]) {
    const parsed = schema.safeParse(row);
    if (parsed.success) valid.push(parsed.data as z.infer<T>);
  }
  return { rows: valid, dropped: all.length - valid.length };
}

/**
 * Where the auth session is stored, one key per project. One fixed key would
 * let a session (and its refresh token) for one project be sent to the next
 * project the user connects to. The key also names auth-js's cross-tab channel.
 */
export function authStorageKey(url: string): string {
  const u = new URL(url);
  return `${AUTH_STORAGE_PREFIX}${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * The single key every project shared before sessions were stored per
 * project. Which project it belongs to can't be told reliably, so it is
 * deleted unread: affected users sign in once more.
 */
export const LEGACY_AUTH_STORAGE_KEY = "tavro.auth";

/**
 * Removes a stored session and auth-js's companion entries, locally only.
 * Resolves once an async store (Expo) has removed them; never rejects.
 */
function removeStoredSession(storage: KeyValueStorage, key: string): Promise<void> {
  return removeKeys(storage, [key, `${key}-user`, `${key}-code-verifier`]);
}

/**
 * The `sub` claim of an access token, or null if it can't be read. Not
 * verified (the database does that): only names whose token was sent.
 */
export function jwtSubject(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const sub = (JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch {
    return null;
  }
}

/** Sends a request with exactly this token: supabase-js only adds its own when none is set. */
function withToken<B extends { setHeader(name: string, value: string): B }>(query: B, token: string | null): B {
  return token === null ? query : query.setHeader("Authorization", `Bearer ${token}`);
}

/**
 * supabase-js has no request timeout, so a request that hangs without failing
 * (captive portal, dead proxy, sleeping radio) would keep a query "fetching"
 * forever and hide the offline banner. Abort after this long; the query then
 * fails like any network error. Long enough for a slow mobile connection.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Wraps fetch so every request is aborted after `ms`, while still honouring the caller's own signal. */
export function withRequestTimeout(fetchImpl: FetchLike, ms: number = REQUEST_TIMEOUT_MS): FetchLike {
  return (input, init) => {
    const controller = new AbortController();
    const outer = init?.signal;
    const abortFromOuter = () => controller.abort(outer?.reason);
    if (outer?.aborted) abortFromOuter();
    else outer?.addEventListener("abort", abortFromOuter, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${ms} ms`)), ms);
    return fetchImpl(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abortFromOuter);
    });
  };
}

/** Realtime topic prefix the database's realtime.messages policy allows owners to join. */
export const REALTIME_TOPIC_PREFIX = "tavro-changes:";
/** What `subscribe` listens to: never hosts (polled) and never DELETE (not RLS-filtered). */
export const REALTIME_TABLES: readonly ChangeTopic[] = ["sessions", "session_events"];
export const REALTIME_EVENTS = ["INSERT", "UPDATE"] as const;

/**
 * Supabase-backed implementation. Uses only the publishable key plus the
 * signed-in user's JWT; every query is authorised by RLS in the database.
 */
export function createSupabaseApi(config: ConnectionConfig, storage: KeyValueStorage): TavroApi {
  const { url, publishableKey } = ConnectionConfig.parse(config);
  const storageKey = authStorageKey(url);
  // Before the client exists, so no client can ever read it.
  void removeStoredSession(storage, LEGACY_AUTH_STORAGE_KEY);
  // Sign-ins to other projects: this device has moved on from them (L2).
  void removeOtherAuthSessions(storage, storageKey);
  const client: SupabaseClient = createClient(url, publishableKey, {
    // Explicit per-project key, so a failed local sign-out can still drop the stored session.
    auth: { storage, storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: withRequestTimeout((input, init) => fetch(input, init)) },
    // supabase-js would retry reads itself (3x, on network errors, 503, 520),
    // multiplying the app's own retries during an outage; the query client owns retrying.
    db: { retry: false },
  });

  const toUser = (u: { id: string; email?: string | null } | null | undefined): AuthUser | null =>
    u ? { id: u.id, email: u.email ?? null } : null;
  // Auth listeners, for a sign-out completed here rather than by auth-js.
  const signedOutHere = new Set<(user: AuthUser | null) => void>();

  /**
   * Ends the session on this device without a network request. With nothing
   * stored, auth-js's local sign-out sends no logout request but still runs its
   * own removal, which stops an in-flight refresh re-saving the session and
   * tells this tab and other tabs (BroadcastChannel). Only if that fails are
   * auto-refresh stopped and this tab's listeners told here.
   */
  async function dropLocalSession(): Promise<void> {
    await removeStoredSession(storage, storageKey);
    const again = await client.auth.signOut({ scope: "local" }).catch((e: unknown) => ({ error: e }));
    if (!again.error) return;
    await client.auth.stopAutoRefresh();
    for (const cb of signedOutHere) cb(null);
  }

  /**
   * The token a request pinned to `options.asUser` sends, or null when it
   * isn't pinned (supabase-js then sends whatever is stored). Throws, sending
   * nothing, when the stored sign-in is gone or belongs to another account,
   * or when the token's account can't be read from it.
   */
  async function pinnedToken(options: ReadOptions | undefined): Promise<string | null> {
    const asUser = options?.asUser;
    if (asUser === undefined) return null;
    // auth-js refreshes an expiring session here, as it would for the request itself.
    const { data, error } = await client.auth.getSession().catch((e: unknown) => ({ data: { session: null }, error: e as { name?: string; status?: number } }));
    const session = data.session;
    if (!session) {
      // A refresh that failed on the network or a 5xx is an outage, not an expired sign-in.
      const mapped = error ? toSignInError(error) : null;
      if (mapped && mapped.code !== "unauthorized") throw mapped;
      throw new ApiError(SESSION_EXPIRED_MESSAGE, "unauthorized");
    }
    // The account the database will answer for is the token's own. A token
    // whose sub can't be read fails closed: the user record stored beside it
    // says nothing about whom the database would answer as (I1).
    if (jwtSubject(session.access_token) !== asUser) throw new ApiError(ACCOUNT_CHANGED_MESSAGE, "account_changed");
    return session.access_token;
  }

  // Live-updates status of the latest subscription (`liveChannel`), for Settings. Only the
  // join state is kept: realtime-js's error object is never stored or passed on.
  let liveChannel: object | null = null;
  let liveStatus: LiveUpdatesStatus | null = null;
  const liveListeners = new Set<() => void>();
  // What the latest session list left out; forgotten with the user's session,
  // and whenever this tab's auth reports a different user (a sign-in in another tab).
  const sessionList = createSessionListStore();
  const sessionListUser = client.auth.onAuthStateChange((_event, session) => sessionList.setUser(session?.user.id ?? null));
  const setLiveStatus = (channel: object, next: LiveUpdatesStatus | null) => {
    if (channel !== liveChannel || next === liveStatus) return;
    liveStatus = next;
    for (const l of liveListeners) l();
  };

  return {
    kind: "supabase",

    liveUpdates: {
      status: () => liveStatus,
      onChange(cb) {
        liveListeners.add(cb);
        return () => void liveListeners.delete(cb);
      },
    },

    sessionList: { gaps: sessionList.gaps, onChange: sessionList.onChange },

    async getSchemaVersion() {
      const { data, error, status } = await client.from("app_meta").select("schema_version").maybeSingle();
      if (error) {
        // Table missing => schema not installed.
        if (error.code === "42P01" || error.code === "PGRST205") return null;
        // A rejected sign-in or permission is not an outage: only blame
        // reachability when the project really didn't answer.
        throw toApiError(error, status);
      }
      return (data as { schema_version: number } | null)?.schema_version ?? null;
    },

    async getUser() {
      const { data } = await client.auth.getSession();
      return toUser(data.session?.user);
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw toSignInError(error);
    },
    async signOut(options) {
      sessionList.reset();
      const { error } = await client.auth.signOut(options?.localOnly ? { scope: "local" } : undefined);
      if (!error) return { serverRevoked: true };
      // auth-js keeps the session if it couldn't load it first (e.g. a refresh that
      // failed on the network); a later successful auto-refresh would then sign the
      // user back in silently. Signing out must always end the session on this
      // device, so remove it ourselves. (If only the logout request failed, auth-js
      // has already removed it.) Either way the server was not told.
      if ((await storage.getItem(storageKey)) !== null) await dropLocalSession();
      return { serverRevoked: false };
    },
    async close() {
      // No logout request: a user leaving a project is often leaving one that
      // is unreachable or refuses the key, and nothing may go to the next one.
      sessionList.reset();
      sessionListUser.data.subscription.unsubscribe();
      await dropLocalSession();
      await client.auth.dispose();
      void client.realtime.disconnect();
    },
    onAuthChange(cb) {
      const { data } = client.auth.onAuthStateChange((_event, session) => cb(toUser(session?.user)));
      signedOutHere.add(cb);
      return () => {
        signedOutHere.delete(cb);
        data.subscription.unsubscribe();
      };
    },

    async listSessions(options) {
      const auth = await pinnedToken(options);
      const token = sessionList.begin();
      // One row past the limit, only to learn whether more exist. Most recent
      // activity first, so the newest are kept: no activity yet sorts last
      // (Postgres puts NULLs first in DESC), and id breaks ties at the
      // cut-off, so the same sessions are kept on every poll.
      const { data, error, status } = await withToken(
        client
          .from("sessions")
          .select("*")
          .order("last_activity_at", { ascending: false, nullsFirst: false })
          .order("id")
          .limit(SESSION_LIST_LIMIT + 1),
        auth,
      );
      if (error) throw toApiError(error, status);
      // Parsed before the cut, so valid rows past the limit fill the places of
      // unreadable ones. More rows than the limit came back: more may exist.
      const raw: unknown = data ?? [];
      const { rows, dropped } = parseEachRow(SessionRow, raw);
      const truncated = Array.isArray(raw) && raw.length > SESSION_LIST_LIMIT;
      sessionList.report(token, { truncated, dropped });
      return rows.slice(0, SESSION_LIST_LIMIT);
    },
    async getSession(id, options) {
      const auth = await pinnedToken(options);
      const { data, error, status } = await withToken(client.from("sessions").select("*").eq("id", id).maybeSingle(), auth);
      if (error) throw toApiError(error, status);
      if (!data) return null;
      // A malformed row (one the list drops) gets a message safe to show; zod's issues quote values.
      const parsed = SessionRow.safeParse(data);
      if (!parsed.success) throw new ApiError(SESSION_UNREADABLE_MESSAGE, "invalid");
      return parsed.data;
    },
    async listEvents(sessionId, limit = 100, options) {
      const auth = await pinnedToken(options);
      const query = client
        .from("session_events")
        .select("*")
        .eq("session_id", sessionId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      const { data, error, status } = await withToken(query, auth);
      if (error) throw toApiError(error, status);
      return parseRows(SessionEventRow, data);
    },
    async listMessages(sessionId, limit = 50, options) {
      const auth = await pinnedToken(options);
      const query = client
        .from("session_messages")
        .select("id, session_id, external_uuid, role, text, occurred_at")
        .eq("session_id", sessionId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      const { data, error, status } = await withToken(query, auth);
      if (error) throw toApiError(error, status);
      return parseRows(SessionMessageRow, data).reverse();
    },

    async listHosts(options) {
      const auth = await pinnedToken(options);
      const query = client
        .from("hosts")
        .select("id, owner_id, name, platform, connector_version, remote_control_allowed, last_seen_at, provider_error_since, provider_error_kind, paired_at, revoked_at, created_at")
        .order("created_at");
      const { data, error, status } = await withToken(query, auth);
      if (error) throw toApiError(error, status);
      return parseRows(HostRow, data);
    },
    async createHostPairing(name, options) {
      // The host is created for whoever's token goes out, and the laptop that
      // redeems the code then syncs to that account: never another tab's (L1).
      const auth = await pinnedToken(options);
      const { data, error, status } = await withToken(client.rpc("create_host_pairing", { p_name: name }), auth);
      if (error) throw toApiError(error, status);
      const row = (data as unknown[] | null)?.[0];
      return PairingTicket.parse(row);
    },
    async revokeHost(hostId, options) {
      const auth = await pinnedToken(options);
      const query = client.from("hosts").update({ revoked_at: new Date().toISOString() }).eq("id", hostId).select("id");
      const { data, error, status } = await withToken(query, auth);
      if (error) throw toApiError(error, status);
      if (!data?.length) throw new ApiError("Host not found.", "not_found");
    },

    async getNotificationPrefs(options) {
      const auth = await pinnedToken(options);
      // A missing row means "never saved" (defaults), so whose token asked matters here too.
      const query = client
        .from("notification_prefs")
        .select("on_waiting_for_input, on_approval_required, on_completed, on_failed, on_host_disconnected, on_host_reconnected")
        .maybeSingle();
      const { data, error, status } = await withToken(query, auth);
      if (error) throw toApiError(error, status);
      return data ? NotificationPrefs.parse(data) : null;
    },
    async saveNotificationPrefs(prefs, options) {
      const auth = await pinnedToken(options);
      // Pinned: the checked token's account; otherwise whoever is stored.
      const ownerId = auth !== null ? options?.asUser : toUser((await client.auth.getSession()).data.session?.user)?.id;
      if (!ownerId) throw new ApiError(SESSION_EXPIRED_MESSAGE, "unauthorized");
      const query = client
        .from("notification_prefs")
        .upsert({ owner_id: ownerId, ...NotificationPrefs.parse(prefs), updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
      const { error, status } = await withToken(query, auth);
      if (error) throw toApiError(error, status);
    },

    subscribe(cb) {
      // Invalidation only: payloads are ignored and every refetch goes through
      // RLS. A private channel, so the project can keep Realtime "Allow public
      // access" off; migration 20261105000001 lets owners (not hosts) join
      // `tavro-changes:*` and nobody send on it. The random suffix keeps
      // channels distinct (realtime-js reuses a channel with the same topic).
      // Only INSERT and UPDATE: DELETE events are not filtered by RLS, and
      // rows are never deleted (revocation is a flag). No hosts: their 30 s
      // heartbeat would wake every client; the host list is polled instead.
      const channel = client.channel(`${REALTIME_TOPIC_PREFIX}${Math.random().toString(36).slice(2)}`, { config: { private: true } });
      for (const table of REALTIME_TABLES) {
        for (const event of REALTIME_EVENTS) {
          channel.on("postgres_changes", { event, schema: "public", table }, () => cb(table));
        }
      }
      // A failed join (e.g. the migration not yet applied) loses no data: the
      // 30 s poll covers a missing channel. It is surfaced in Settings only,
      // through liveUpdates; realtime-js keeps retrying the join on its own.
      liveChannel = channel;
      setLiveStatus(channel, "connecting");
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") setLiveStatus(channel, "on");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setLiveStatus(channel, "unavailable");
      });
      return () => {
        // Forgotten first, so the CLOSED that removal causes isn't reported.
        setLiveStatus(channel, null);
        if (liveChannel === channel) liveChannel = null;
        void client.removeChannel(channel);
      };
    },
  };
}
