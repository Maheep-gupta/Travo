// SupabaseTransport against a stubbed network (spec 6.2, 16): a refused host
// is told apart from an unreachable backend, and neither leaks credentials.
// Responses mimic GoTrue and PostgREST closely enough for supabase-js; this is
// not a substitute for `npm run test:db`.
import { describe, expect, it } from "vitest";
import { AUTH_RETRY_MS, Connector } from "../src/connector.js";
import { HostAuthError, TranscriptsRefusedError } from "../src/transports/errors.js";
import { SupabaseTransport } from "../src/transports/supabase.js";
import type { Provider } from "../src/types.js";

const URL_BASE = "https://example.supabase.co";
const CREDS = { host_id: "11111111-1111-4111-8111-111111111111", email: "host-abc@hosts.invalid", password: "p".repeat(40) };
const HEARTBEAT = { platform: "test", connector_version: "t", remote_control_allowed: false, provider_ok: true };

type Route = "token" | "heartbeat" | "sessions" | "messages" | "app_meta";
type Reply = Response | "network";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SESSION = {
  access_token: "header.payload.signature",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "refresh",
  user: { id: "22222222-2222-4222-8222-222222222222", aud: "authenticated", role: "authenticated", email: CREDS.email, app_metadata: {}, user_metadata: {}, created_at: "2026-10-29T12:00:00Z" },
};

/** A fake backend: each route answers from its queue (the last reply repeats). */
function backend(replies: Partial<Record<Route, Reply[]>>) {
  const calls: Route[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route: Route | null = url.includes("/auth/v1/token")
      ? "token"
      : url.includes("/rest/v1/rpc/host_heartbeat")
        ? "heartbeat"
        : url.includes("/rest/v1/sessions")
          ? "sessions"
          : url.includes("/rest/v1/session_messages")
            ? "messages"
            : url.includes("/rest/v1/app_meta")
              ? "app_meta"
              : null;
    // Answered with an HTTP error, not a throw: postgrest-js retries network errors on reads.
    if (!route) return json(404, { code: "PGRST000", message: "unexpected request in test" });
    calls.push(route);
    const queue = replies[route] ?? (route === "sessions" ? [json(200, [])] : []);
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? json(500, {});
    if (reply === "network") throw new TypeError("fetch failed");
    return reply.clone();
  }) as typeof fetch;
  return { calls, transport: new SupabaseTransport(URL_BASE, "sb_publishable_test", CREDS, fetchImpl) };
}

const rejected = () => json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
/** What the API gateway answers for a rotated or mistyped publishable key. */
const badKey = () => json(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
const MESSAGE = { session_id: "33333333-3333-4333-8333-333333333333", external_uuid: "u1", role: "user" as const, text: "SYNTHETIC-SECRET-MARKER", occurred_at: "2026-10-29T12:00:00Z" };
const forbidden = (message: string) => json(403, { code: "42501", message, details: null, hint: null });

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
}

describe("SupabaseTransport sign-in", () => {
  it("reports a rejected credential as a refusal, without credentials in the message", async () => {
    const { transport } = backend({ token: [rejected()] });
    const e = await failure(transport.heartbeat(HEARTBEAT));
    expect(e).toBeInstanceOf(HostAuthError);
    expect(e.message).toBe("host sign-in rejected (invalid_credentials)");
    expect(e.message).not.toContain(CREDS.email);
    expect(e.message).not.toContain(CREDS.password);
  });

  it("reports a network failure as an ordinary (retryable) error", async () => {
    const { transport } = backend({ token: ["network"] });
    const e = await failure(transport.heartbeat(HEARTBEAT));
    expect(e).not.toBeInstanceOf(HostAuthError);
    expect(e.message).toBe("host sign-in failed (network)");
  });

  it.each([429, 503])("treats auth answering %i as retryable, not a refusal", async (status) => {
    const { transport } = backend({ token: [json(status, { msg: "slow down" })] });
    expect(await failure(transport.heartbeat(HEARTBEAT))).not.toBeInstanceOf(HostAuthError);
  });

  it("reports a revoked host (heartbeat refused with 42501) as a refusal", async () => {
    const { transport } = backend({ token: [json(200, SESSION)], heartbeat: [json(403, { code: "42501", message: "not an active host", details: null, hint: null })] });
    const e = await failure(transport.heartbeat(HEARTBEAT));
    expect(e).toBeInstanceOf(HostAuthError);
    expect(e.message).toBe("this host is no longer active (42501)");
  });

  it("tells a rejected publishable key apart from a refused host, at sign-in and mid-session", async () => {
    const atSignIn = await failure(backend({ token: [badKey()] }).transport.heartbeat(HEARTBEAT));
    expect(atSignIn).toBeInstanceOf(HostAuthError);
    expect(atSignIn).toMatchObject({ remedy: "check_publishable_key", message: "the project rejected the publishable key (401)" });
    const midSession = await failure(backend({ token: [json(200, SESSION)], heartbeat: [badKey()] }).transport.heartbeat(HEARTBEAT));
    expect(midSession).toMatchObject({ remedy: "check_publishable_key" });
    // A wrong password stays a host refusal.
    expect(await failure(backend({ token: [rejected()] }).transport.heartbeat(HEARTBEAT))).toMatchObject({ remedy: "pair_again" });
  });

  it("recovers after a network failure, then reuses the session", async () => {
    const { transport, calls } = backend({ token: ["network", json(200, SESSION)], heartbeat: [json(200, "2026-10-29T12:00:00Z")] });
    await failure(transport.heartbeat(HEARTBEAT));
    await transport.heartbeat(HEARTBEAT);
    await transport.heartbeat(HEARTBEAT);
    expect(calls).toEqual(["token", "token", "heartbeat", "heartbeat"]);
  });
});

describe("SupabaseTransport transcript refusal", () => {
  const signedIn = { token: [json(200, SESSION)] };

  it("is a TranscriptsRefusedError only when app_meta confirms transcripts are off", async () => {
    const { transport } = backend({ ...signedIn, messages: [forbidden("new row violates row-level security policy")], app_meta: [json(200, [{ transcripts_enabled: false }])] });
    expect(await failure(transport.insertMessages([MESSAGE]))).toBeInstanceOf(TranscriptsRefusedError);
  });

  it.each([
    ["the setting is on (owner trigger: session not this host's)", json(200, [{ transcripts_enabled: true }])],
    ["app_meta can't be read", json(401, { code: "PGRST301", message: "JWT expired" })],
    ["app_meta is empty", json(200, [])],
  ])("stays an ordinary error when %s", async (_, appMeta) => {
    const { transport } = backend({ ...signedIn, messages: [forbidden("session does not belong to host")], app_meta: [appMeta] });
    const e = await failure(transport.insertMessages([MESSAGE]));
    expect(e).not.toBeInstanceOf(TranscriptsRefusedError);
    expect(e.message).toBe("insert messages failed (42501)");
    expect(e.message).not.toContain("SYNTHETIC-SECRET-MARKER");
  });

  it("doesn't consult app_meta for other errors", async () => {
    const { transport, calls } = backend({ ...signedIn, messages: [json(409, { code: "23503", message: "fk", details: null, hint: null })] });
    expect((await failure(transport.insertMessages([MESSAGE]))).message).toBe("insert messages failed (23503)");
    expect(calls).not.toContain("app_meta");
  });
});

describe("Connector with a refused host", () => {
  const provider: Provider = { id: "mock", isDemo: true, poll: async () => [] };
  const start = (transport: SupabaseTransport, logs: string[]) =>
    new Connector({ provider, transport, platform: "test", version: "t", remoteControlAllowed: false, syncTranscripts: false, pollMs: 5000, log: (l) => logs.push(l) });

  it("enters auth_failed, logs once how to fix it, and retries only every AUTH_RETRY_MS", async () => {
    const logs: string[] = [];
    const { transport, calls } = backend({ token: [rejected(), rejected(), rejected(), json(200, SESSION)], heartbeat: [json(200, "2026-10-29T12:00:00Z")] });
    const connector = start(transport, logs);
    for (let i = 0; i < 3; i++) expect(await connector.runOnce()).toBe(AUTH_RETRY_MS);
    expect(connector.connectionState).toBe("auth_failed");
    expect(logs.filter((l) => l.startsWith("not authorized: host sign-in rejected (invalid_credentials)"))).toHaveLength(1);
    expect(logs[0]).toContain("pair");
    expect(logs.some((l) => l.startsWith("offline"))).toBe(false);
    expect(logs.join("\n")).not.toContain(CREDS.password);

    // Credentials accepted again: back online at once with a heartbeat.
    expect(await connector.runOnce()).toBe(5000);
    expect(connector.connectionState).toBe("online");
    expect(calls.filter((c) => c === "heartbeat")).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/^online: the backend accepts this host again/);
  });

  it("says to check the publishable key, not to pair again, when the key is rejected", async () => {
    const logs: string[] = [];
    const connector = start(backend({ token: [badKey()] }).transport, logs);
    expect(await connector.runOnce()).toBe(AUTH_RETRY_MS);
    expect(connector.connectionState).toBe("auth_failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("MC_SUPABASE_PUBLISHABLE_KEY");
    expect(logs[0]).not.toContain("may have been revoked");
  });

  it("goes from auth_failed to offline when the network then drops", async () => {
    const logs: string[] = [];
    const { transport } = backend({ token: [rejected(), "network"] });
    const connector = start(transport, logs);
    expect(await connector.runOnce()).toBe(AUTH_RETRY_MS);
    expect(connector.connectionState).toBe("auth_failed");
    const delay = await connector.runOnce();
    expect(connector.connectionState).toBe("offline");
    expect(delay).toBeLessThan(AUTH_RETRY_MS);
    expect(logs.at(-1)).toBe("offline: host sign-in failed (network)");
  });

  it("keeps a network failure as offline with the normal backoff", async () => {
    const logs: string[] = [];
    const { transport } = backend({ token: ["network"] });
    const connector = start(transport, logs);
    const delay = await connector.runOnce();
    expect(connector.connectionState).toBe("offline");
    expect(delay).toBeLessThan(AUTH_RETRY_MS);
    expect(logs).toEqual(["offline: host sign-in failed (network)"]);
  });
});
