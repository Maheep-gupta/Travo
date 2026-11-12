// A session for one project must never reach another (security review M1).
// Sessions used to share one storage key, so after Change backend the next
// project received the previous one's access token on every request, and its
// refresh token on the next refresh. Runs the real supabase-js client against
// a stubbed fetch that records every request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TavroApi } from "../src/api.js";
import { MemoryStorage } from "../src/storage.js";
import { LEGACY_AUTH_STORAGE_KEY, authStorageKey, createSupabaseApi } from "../src/supabase-api.js";

const X = "https://project-x.supabase.co";
const Y = "https://project-y.supabase.co";
const PUBLISHABLE = "sb_publishable_0123456789abcdef";
const OLD_ACCESS = "old-access-token-of-project-x";
const OLD_REFRESH = "old-refresh-token-of-project-x";
const LEGACY_ACCESS = "legacy-access-token";
const LEGACY_REFRESH = "legacy-refresh-token";

interface Sent {
  url: string;
  authorization: string | null;
  body: string;
}

let sent: Sent[];
let storage: MemoryStorage;
const open: TavroApi[] = [];

function session(access: string, refresh: string, expiresInS: number): string {
  return JSON.stringify({
    access_token: access,
    refresh_token: refresh,
    token_type: "bearer",
    expires_in: Math.max(expiresInS, 0),
    expires_at: Math.floor(Date.now() / 1000) + expiresInS,
    user: { id: "00000000-0000-4000-8000-00000000000a", email: "a@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-29T10:00:00Z" },
  });
}

function connect(url: string): TavroApi {
  const api = createSupabaseApi({ url, publishableKey: PUBLISHABLE }, storage);
  open.push(api);
  return api;
}

/** Everything sent to `origin` that carries one of these secrets, in a header or the body. */
function leaksTo(origin: string, ...secrets: string[]): Sent[] {
  return sent.filter((r) => r.url.startsWith(origin) && secrets.some((s) => (r.authorization ?? "").includes(s) || r.body.includes(s)));
}

beforeEach(() => {
  sent = [];
  storage = new MemoryStorage();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    sent.push({ url, authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : "" });
    if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    if (url.includes("/auth/v1/token")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  for (const api of open.splice(0)) await api.close();
  vi.unstubAllGlobals();
});

describe("per-project session storage", () => {
  it("keys the session by project, so X's session is never read for Y even without Change backend", async () => {
    // Expired, so a client that read it would also try to refresh it.
    storage.setItem(authStorageKey(X), session(OLD_ACCESS, OLD_REFRESH, -60));
    const y = connect(Y);
    expect(await y.getUser()).toBeNull();
    await y.listSessions();
    await y.signOut();
    expect(leaksTo(Y, OLD_ACCESS, OLD_REFRESH)).toEqual([]);
    // Not kept either: creating Y removes other projects' sign-ins unread (L2).
    expect(storage.getItem(authStorageKey(X))).toBeNull();
  });

  it("deletes the legacy shared key unread", async () => {
    storage.setItem(LEGACY_AUTH_STORAGE_KEY, session(LEGACY_ACCESS, LEGACY_REFRESH, -60));
    const y = connect(Y);
    expect(storage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(await y.getUser()).toBeNull();
    await y.listSessions();
    expect(leaksTo(Y, LEGACY_ACCESS, LEGACY_REFRESH)).toEqual([]);
  });

  it("separates projects by origin and path, ignoring a trailing slash", () => {
    expect(authStorageKey(X)).not.toBe(authStorageKey(Y));
    expect(authStorageKey(`${X}/`)).toBe(authStorageKey(X));
    expect(authStorageKey("https://host.example/a")).not.toBe(authStorageKey("https://host.example/b"));
  });
});

describe("Change backend", () => {
  it("removes X's session with no request at all, and Y never receives X's tokens", async () => {
    storage.setItem(authStorageKey(X), session(OLD_ACCESS, OLD_REFRESH, 3600));
    const x = connect(X);
    await x.listSessions();
    // The fixture really is in use: X's own requests carry its token.
    expect(sent.some((r) => r.url.startsWith(X) && r.authorization === `Bearer ${OLD_ACCESS}`)).toBe(true);

    const before = sent.length;
    await x.close();
    expect(sent.slice(before)).toEqual([]);
    expect(storage.getItem(authStorageKey(X))).toBeNull();

    const y = connect(Y);
    expect(await y.getUser()).toBeNull();
    await y.listSessions();
    await y.signOut();
    expect(leaksTo(Y, OLD_ACCESS, OLD_REFRESH)).toEqual([]);
    // Y's requests went out with the publishable key only.
    expect(sent.filter((r) => r.url.startsWith(Y)).every((r) => r.authorization === null || r.authorization === `Bearer ${PUBLISHABLE}`)).toBe(true);
  });
});
