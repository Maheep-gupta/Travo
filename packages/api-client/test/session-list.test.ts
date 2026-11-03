// The session list (G28): capped at SESSION_LIST_LIMIT with the newest kept and
// the cut said, and one malformed row dropped and counted instead of failing
// the list. Through the real supabase-js stack; only counts leave the parser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_LIST_LIMIT } from "@mc/contracts/constants";
import { NO_SESSION_LIST_GAPS } from "@mc/domain";
import { createDemoApi } from "../src/demo-api.js";
import { createSessionListStore } from "../src/session-list-store.js";
import { MemoryStorage } from "../src/storage.js";
import { authStorageKey, createSupabaseApi, parseEachRow } from "../src/supabase-api.js";
import { SessionRow } from "@mc/contracts";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const row = (n: number) => ({
  id: uuid(n),
  owner_id: uuid(1),
  host_id: uuid(2),
  provider: "mock",
  external_id: `s-${n}`,
  title: `Session ${n}`,
  project_label: null,
  status: "running",
  status_reason: null,
  status_source: "mock",
  last_activity_at: new Date(Date.UTC(2026, 10, 3) - n * 1000).toISOString(),
  last_event_summary: null,
  capabilities: [],
  is_demo: false,
  started_at: null,
  ended_at: null,
  updated_at: "2026-11-03T00:00:00.000Z",
});

/** Recognisable content that must never reach a result, an error or a log. */
const SECRET = "SYNTHETIC-ROW-SECRET";

describe("parseEachRow", () => {
  it("drops and counts malformed rows, keeping the valid ones in order", () => {
    const bad = { ...row(2), status: SECRET };
    const out = parseEachRow(SessionRow, [row(1), bad, row(3), null, "x"]);
    expect(out.rows.map((r) => r.id)).toEqual([uuid(1), uuid(3)]);
    expect(out.dropped).toBe(3);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("treats no data as an empty list, and a response that isn't a list as a failure", () => {
    expect(parseEachRow(SessionRow, null)).toEqual({ rows: [], dropped: 0 });
    expect(() => parseEachRow(SessionRow, { rows: [] })).toThrow(/request failed/);
  });
});

describe("createSessionListStore", () => {
  it("keeps the same object while nothing changes, and ignores a request from before a reset", () => {
    const store = createSessionListStore();
    const seen = vi.fn();
    store.onChange(seen);
    expect(store.gaps()).toBeNull();
    store.report(store.begin(), { truncated: false, dropped: 0 });
    expect(store.gaps()).toBe(NO_SESSION_LIST_GAPS);
    const first = store.begin();
    store.report(first, { truncated: true, dropped: 2 });
    const gaps = store.gaps();
    store.report(store.begin(), { truncated: true, dropped: 2 });
    expect(store.gaps()).toBe(gaps);
    expect(seen).toHaveBeenCalledTimes(2);
    // A previous user's request that finishes after sign-out.
    const stale = store.begin();
    store.reset();
    store.report(stale, { truncated: true, dropped: 9 });
    expect(store.gaps()).toBeNull();
  });
});

describe("Supabase listSessions", () => {
  const logs: unknown[][] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    logs.length = 0;
  });

  function stubSessions(rows: unknown[]) {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rest/v1/sessions")) return Promise.resolve(new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }));
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createSupabaseApi({ url: "https://example.supabase.co", publishableKey: "sb_publishable_0123456789abcdef" }, new MemoryStorage());
    const sessionsUrl = () => new URL(String(fetchMock.mock.calls.find(([i]) => String(i).includes("/rest/v1/sessions"))?.[0]));
    return { api, sessionsUrl };
  }

  it("asks for one row past the limit, newest activity first with no activity last, then by id", async () => {
    const { api, sessionsUrl } = stubSessions([row(1)]);
    await api.listSessions();
    expect(sessionsUrl().searchParams.get("limit")).toBe(String(SESSION_LIST_LIMIT + 1));
    expect(sessionsUrl().searchParams.get("order")).toBe("last_activity_at.desc.nullslast,id.asc");
  });

  it("returns the limit and reports the cut when more sessions exist", async () => {
    const all = Array.from({ length: SESSION_LIST_LIMIT + 1 }, (_, i) => row(i + 1));
    const { api } = stubSessions(all);
    const rows = await api.listSessions();
    expect(rows).toHaveLength(SESSION_LIST_LIMIT);
    expect(rows.at(-1)?.id).toBe(uuid(SESSION_LIST_LIMIT));
    expect(api.sessionList?.gaps()).toEqual({ truncated: true, dropped: 0 });
  });

  it("reports nothing missing at exactly the limit", async () => {
    const { api } = stubSessions(Array.from({ length: SESSION_LIST_LIMIT }, (_, i) => row(i + 1)));
    expect(await api.listSessions()).toHaveLength(SESSION_LIST_LIMIT);
    expect(api.sessionList?.gaps()).toEqual({ truncated: false, dropped: 0 });
  });

  it("drops a malformed row instead of failing the list, counts it, and never logs it", async () => {
    const { api } = stubSessions([row(1), { ...row(2), title: SECRET, status: SECRET }, row(3)]);
    const rows = await api.listSessions();
    expect(rows.map((r) => r.id)).toEqual([uuid(1), uuid(3)]);
    expect(api.sessionList?.gaps()).toEqual({ truncated: false, dropped: 1 });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("forgets the gaps on sign-out", async () => {
    const { api } = stubSessions([row(1), { id: "not-a-uuid" }]);
    await api.listSessions();
    expect(api.sessionList?.gaps()).toEqual({ truncated: false, dropped: 1 });
    await api.signOut({ localOnly: true });
    expect(api.sessionList?.gaps()).toBeNull();
  });
});

describe("demo listSessions", () => {
  it("follows the same order and reports a complete list", async () => {
    const api = createDemoApi({ tickMs: 0, seed: 7 });
    expect(api.sessionList?.gaps()).toBeNull();
    const rows = await api.listSessions();
    const activity = rows.map((r) => r.last_activity_at ?? "");
    expect(activity).toEqual([...activity].sort().reverse());
    expect(api.sessionList?.gaps()).toBe(NO_SESSION_LIST_GAPS);
    await api.signOut();
    expect(api.sessionList?.gaps()).toBeNull();
  });
});

describe("Supabase listSessions: parsed before the cut (QA LOW-5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function respondWith(rows: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = url.includes("/rest/v1/sessions") ? JSON.stringify(rows) : "{}";
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      }),
    );
    return createSupabaseApi({ url: "https://example.supabase.co", publishableKey: "sb_publishable_0123456789abcdef" }, new MemoryStorage());
  }

  it("fills an unreadable row's place from past the limit, so a cut list still shows the limit", async () => {
    const all: unknown[] = Array.from({ length: SESSION_LIST_LIMIT + 1 }, (_, i) => row(i + 1));
    all[1] = { ...row(2), status: SECRET };
    const api = respondWith(all);
    const rows = await api.listSessions();
    expect(rows).toHaveLength(SESSION_LIST_LIMIT);
    expect(rows.at(-1)?.id).toBe(uuid(SESSION_LIST_LIMIT + 1));
    expect(rows.some((r) => r.id === uuid(2))).toBe(false);
    expect(api.sessionList?.gaps()).toEqual({ truncated: true, dropped: 1 });
  });

  it("gives one unreadable session a safe error when it is asked for on its own", async () => {
    const api = respondWith([{ ...row(2), title: SECRET, status: SECRET }]);
    const error: unknown = await api.getSession(uuid(2)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ApiError", code: "invalid", message: "This session's data couldn't be read." });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});

describe("session list gaps follow the signed-in user (QA LOW-4)", () => {
  it("forgets the gaps, and ignores a late response, once a different user is reported", () => {
    const store = createSessionListStore();
    store.setUser("a");
    store.report(store.begin(), { truncated: true, dropped: 0 });
    // The same user again (a token refresh) keeps them.
    store.setUser("a");
    expect(store.gaps()).toEqual({ truncated: true, dropped: 0 });
    const lateForA = store.begin();
    store.setUser("b");
    expect(store.gaps()).toBeNull();
    store.report(lateForA, { truncated: false, dropped: 4 });
    expect(store.gaps()).toBeNull();
    store.report(store.begin(), { truncated: false, dropped: 1 });
    expect(store.gaps()).toEqual({ truncated: false, dropped: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is wired to the Supabase client's auth events: A's late list can't describe B's", async () => {
    const user = (id: string) => ({ id, email: `${id.slice(-1)}@example.test`, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-29T10:00:00Z" });
    const stored = (id: string) => ({
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: user(id),
    });
    const A = uuid(0xa);
    const B = uuid(0xb);
    // A holder, so the assignment inside fetch isn't narrowed away.
    const list: { answer: ((rows: unknown[]) => void) | null } = { answer: null };
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/auth/v1/token")) return Promise.resolve(json(stored(B)));
      if (url.includes("/rest/v1/sessions")) return new Promise<Response>((resolve) => (list.answer = (rows) => resolve(json(rows))));
      return Promise.resolve(json({}));
    });
    const storage = new MemoryStorage();
    storage.setItem(authStorageKey("https://example.supabase.co"), JSON.stringify(stored(A)));
    const api = createSupabaseApi({ url: "https://example.supabase.co", publishableKey: "sb_publishable_0123456789abcdef" }, storage);
    try {
      expect((await api.getUser())?.id).toBe(A);
      // A's list is in flight when this tab's auth switches to B.
      const listForA = api.listSessions();
      await vi.waitFor(() => expect(list.answer).not.toBeNull());
      await api.signIn("b@example.test", "password");
      expect((await api.getUser())?.id).toBe(B);
      list.answer?.([row(1), { id: "not-a-uuid" }]);
      await listForA;
      expect(api.sessionList?.gaps()).toBeNull();
    } finally {
      await api.close();
    }
  });
});
