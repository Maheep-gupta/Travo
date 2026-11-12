// Security re-check follow-ups (G32), run on the real supabase-js client
// against a stubbed fetch that records every request:
// - L2: a project's stored sign-in could outlive leaving it when another tab,
//   still open on that project, signed back in to it. Each new backend now
//   removes every other project's stored sign-in.
// - L3: reads pinned to a user (ReadOptions.asUser) send that user's token or
//   nothing, so another tab's sign-in can't answer as this user.
// - L1 (security review, seventh cycle): writes and session detail reads are
//   pinned the same way, so a pairing code is never created for another tab's account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "@mc/contracts/constants";
import { ACCOUNT_CHANGED_MESSAGE, ApiError, type TavroApi } from "../src/api.js";
import { createDemoApi } from "../src/demo-api.js";
import { MemoryStorage, isAuthEntryOf, removeOtherAuthSessions, type KeyValueStorage } from "../src/storage.js";
import { PROJECT_UNAVAILABLE_MESSAGE, SESSION_EXPIRED_MESSAGE, authStorageKey, createSupabaseApi, jwtSubject } from "../src/supabase-api.js";

const X = "https://project-x.supabase.co";
const Y = "https://project-y.supabase.co";
const PUBLISHABLE = "sb_publishable_0123456789abcdef";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

interface Sent {
  url: string;
  authorization: string | null;
  body: string | null;
}

const HOST = "00000000-0000-4000-8000-0000000000c1";
const TICKET = { host_id: HOST, code: "ABCD-EFGH-JKLM", expires_at: "2026-11-12T10:10:00Z" };

let sent: Sent[];
/** What the auth server answers a refresh with: a status, or "network" for no answer. */
let refreshAnswer: number | "network";
let storage: MemoryStorage;
const open: TavroApi[] = [];

/** A JWT-shaped access token for `sub` (unsigned: only the client reads it here). */
function accessToken(sub: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // A fixed expiry, so the same user always gets the same token.
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated", exp: 4_102_444_800 })}.sig`;
}

function session(user: string, expiresInS = 3600, token = accessToken(user)): string {
  return JSON.stringify({
    access_token: token,
    refresh_token: `refresh-${user}`,
    token_type: "bearer",
    expires_in: Math.max(expiresInS, 0),
    expires_at: Math.floor(Date.now() / 1000) + expiresInS,
    user: { id: user, email: null, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-29T10:00:00Z" },
  });
}

function connect(url: string, store: KeyValueStorage = storage): TavroApi {
  const api = createSupabaseApi({ url, publishableKey: PUBLISHABLE }, store);
  open.push(api);
  return api;
}

const restRequests = (): Sent[] => sent.filter((r) => r.url.includes("/rest/v1/"));

beforeEach(() => {
  sent = [];
  refreshAnswer = 400;
  storage = new MemoryStorage();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/v1/token")) {
      if (refreshAnswer === "network") throw new TypeError("Failed to fetch");
      return json(refreshAnswer, { error: refreshAnswer === 400 ? "invalid_grant" : "server_error" });
    }
    if (url.includes("/rpc/create_host_pairing")) return json(200, [TICKET]);
    if (init?.method === "PATCH") return json(200, [{ id: HOST }]);
    return json(200, []);
  });
});

afterEach(async () => {
  for (const api of open.splice(0)) await api.close();
  vi.unstubAllGlobals();
});

describe("other projects' stored sign-ins (L2)", () => {
  it("a stale tab that signs back in to X after this tab left it: the next backend created removes X's sign-in", async () => {
    const kx = authStorageKey(X);
    storage.setItem(kx, session(A));
    const thisTab = connect(X);
    connect(X); // another tab, still open on X
    await thisTab.getUser();
    await thisTab.close();
    expect(storage.getItem(kx)).toBeNull();

    // The other tab, still on X, signs in again: auth-js stores the session and its entries.
    storage.setItem(kx, session(A));
    storage.setItem(`${kx}-user`, "{}");
    storage.setItem(`${kx}-code-verifier`, "v");
    storage.setItem(`${kx}-code-verifier-flow-1`, "v");

    // This tab (or any reload) creates the device's chosen backend, Y.
    const ky = authStorageKey(Y);
    storage.setItem(ky, session(B));
    storage.setItem(`${ky}-user`, "{}");
    storage.setItem("tavro.alerts.v1:supabase:someone", "[]");
    connect(Y);
    await vi.waitFor(() => expect(storage.keys().filter((k) => k.startsWith(kx))).toEqual([]));
    // Y's own sign-in and anything that isn't a sign-in stay.
    expect(storage.getItem(ky)).not.toBeNull();
    expect(storage.getItem(`${ky}-user`)).not.toBeNull();
    expect(storage.getItem("tavro.alerts.v1:supabase:someone")).toBe("[]");
    // Removed unread: nothing of X's went anywhere.
    expect(sent.filter((r) => r.url.startsWith(X))).toEqual([]);
  });

  it("keeps only the project's own entries, not another project whose URL extends it", async () => {
    const ky = authStorageKey(Y);
    const flowSlot = `${ky}-flow-${"0123456789abcdef".repeat(2)}-code-verifier`;
    const own = [ky, `${ky}-user`, `${ky}-code-verifier`, `${ky}-flows-code-verifier`, flowSlot];
    // A different project whose origin starts with Y's: https://project-y.supabase.co-x.example.com
    const lookalike = authStorageKey("https://project-y.supabase.co-x.example.com");
    expect(lookalike.startsWith(`${ky}-`)).toBe(true);
    const others = [lookalike, `${lookalike}-user`, `${ky}-flow-1-code-verifier`, `${ky}-anything`];
    for (const k of [...own, ...others]) storage.setItem(k, k === ky || k === lookalike ? session(A) : "v");

    await removeOtherAuthSessions(storage, ky);
    expect(storage.keys().sort()).toEqual([...own].sort());
    expect(own.every((k) => isAuthEntryOf(ky, k))).toBe(true);
    expect(others.some((k) => isAuthEntryOf(ky, k))).toBe(false);
  });

  it("removes every project's sign-in when none is kept (demo), and waits for an async store", async () => {
    const removed: string[] = [];
    const slow: KeyValueStorage = {
      getItem: (k) => storage.getItem(k),
      setItem: (k, v) => storage.setItem(k, v),
      removeItem: (k) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            storage.removeItem(k);
            removed.push(k);
            resolve();
          }, 5),
        ),
      keys: () => Promise.resolve(storage.keys()),
    };
    storage.setItem(authStorageKey(X), session(A));
    storage.setItem(authStorageKey(Y), session(B));
    storage.setItem("mc.backend", '{"kind":"demo"}');
    await removeOtherAuthSessions(slow, null);
    expect(removed.sort()).toEqual([authStorageKey(X), authStorageKey(Y)].sort());
    expect(storage.keys()).toEqual(["mc.backend"]);
  });

  it("leaves a store that can't list its keys alone, and never rejects on one that refuses", async () => {
    storage.setItem(authStorageKey(X), session(A));
    const unlisted: KeyValueStorage = { getItem: (k) => storage.getItem(k), setItem: (k, v) => storage.setItem(k, v), removeItem: (k) => storage.removeItem(k) };
    await expect(removeOtherAuthSessions(unlisted, null)).resolves.toBeUndefined();
    expect(storage.getItem(authStorageKey(X))).not.toBeNull();

    const refusing: KeyValueStorage = {
      ...unlisted,
      keys: () => {
        throw new Error("SecurityError");
      },
    };
    await expect(removeOtherAuthSessions(refusing, null)).resolves.toBeUndefined();
    const failingRemove: KeyValueStorage = {
      ...unlisted,
      keys: () => storage.keys(),
      removeItem: () => Promise.reject(new Error("SecurityError")),
    };
    await expect(removeOtherAuthSessions(failingRemove, null)).resolves.toBeUndefined();
  });
});

describe("reads pinned to a user (L3)", () => {
  async function signedInAs(user: string): Promise<TavroApi> {
    storage.setItem(authStorageKey(Y), session(user));
    const api = connect(Y);
    expect((await api.getUser())?.id).toBe(user);
    return api;
  }

  /** Every user-owned request the app pins: the alert watcher's reads, the session page's, and every write. */
  const reads = (api: TavroApi, asUser: string): (() => Promise<unknown>)[] => [
    () => api.listSessions({ asUser }),
    () => api.listHosts({ asUser }),
    () => api.getNotificationPrefs({ asUser }),
    () => api.getSession(HOST, { asUser }),
    () => api.listEvents(HOST, 10, { asUser }),
    () => api.listMessages(HOST, 10, { asUser }),
    () => api.createHostPairing("Laptop", { asUser }),
    () => api.revokeHost(HOST, { asUser }),
    () => api.saveNotificationPrefs(DEFAULT_NOTIFICATION_PREFS, { asUser }),
  ];

  it("sends the user's own token", async () => {
    const api = await signedInAs(A);
    for (const read of reads(api, A)) await read();
    expect(restRequests()).toHaveLength(reads(api, A).length);
    expect(restRequests().every((r) => r.authorization === `Bearer ${accessToken(A)}`)).toBe(true);
  });

  it("a pairing code asked for by A while another tab signed in as B is refused, and nothing is sent (L1)", async () => {
    const api = await signedInAs(A);
    storage.setItem(authStorageKey(Y), session(B));
    await expect(api.createHostPairing("Laptop", { asUser: A })).rejects.toMatchObject({ code: "account_changed", message: ACCOUNT_CHANGED_MESSAGE });
    expect(sent.filter((r) => r.url.includes("create_host_pairing"))).toEqual([]);
    // As A again, the code is created with A's token.
    storage.setItem(authStorageKey(Y), session(A));
    await expect(api.createHostPairing("Laptop", { asUser: A })).resolves.toEqual(TICKET);
    expect(restRequests().map((r) => r.authorization)).toEqual([`Bearer ${accessToken(A)}`]);
  });

  it("saves preferences as the pinned user, never as the account stored beside it", async () => {
    const api = await signedInAs(A);
    await api.saveNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, on_failed: false }, { asUser: A });
    const [save] = restRequests();
    expect(save?.authorization).toBe(`Bearer ${accessToken(A)}`);
    expect(JSON.parse(save?.body ?? "{}")).toMatchObject({ owner_id: A, on_failed: false });
  });

  it("sends nothing and fails with account_changed once another tab's sign-in to B replaced A's", async () => {
    const api = await signedInAs(A);
    // Another tab signed in as B: shared storage changed, no auth event here yet.
    storage.setItem(authStorageKey(Y), session(B));
    for (const read of reads(api, A)) {
      await expect(read()).rejects.toMatchObject({ code: "account_changed", message: ACCOUNT_CHANGED_MESSAGE });
    }
    expect(restRequests()).toEqual([]);
    // Asked as B, it answers as B.
    await api.listHosts({ asUser: B });
    expect(restRequests().map((r) => r.authorization)).toEqual([`Bearer ${accessToken(B)}`]);
  });

  it("sends the token it checked, even if the stored sign-in changes before the request goes out", async () => {
    storage.setItem(authStorageKey(Y), session(A));
    // supabase-js reads the stored session again just before sending; swap it in between.
    let armed = false;
    let storageReads = 0;
    const swapping: KeyValueStorage = {
      getItem: (k) => {
        const v = storage.getItem(k);
        if (armed && k === authStorageKey(Y) && ++storageReads === 1) storage.setItem(k, session(B));
        return v;
      },
      setItem: (k, v) => storage.setItem(k, v),
      removeItem: (k) => storage.removeItem(k),
    };
    const api = connect(Y, swapping);
    expect((await api.getUser())?.id).toBe(A);
    sent = [];
    armed = true;
    await api.listSessions({ asUser: A });
    // supabase-js did read B's token for the request; the checked one was sent.
    expect(storageReads).toBeGreaterThan(1);
    expect(restRequests().map((r) => r.authorization)).toEqual([`Bearer ${accessToken(A)}`]);
  });

  it("an empty answer to an anonymous request can't pass as A's: with the sign-in gone it fails as expired", async () => {
    const api = await signedInAs(A);
    storage.removeItem(authStorageKey(Y));
    for (const read of reads(api, A)) {
      await expect(read()).rejects.toMatchObject({ code: "unauthorized", message: SESSION_EXPIRED_MESSAGE });
    }
    expect(restRequests()).toEqual([]);
  });

  it("an expired sign-in whose refresh is refused fails as expired, not as an outage", async () => {
    storage.setItem(authStorageKey(Y), session(A, -60));
    const api = connect(Y);
    await expect(api.listSessions({ asUser: A })).rejects.toMatchObject({ code: "unauthorized" });
    expect(restRequests()).toEqual([]);
  });

  it("checks the sub of the token it would send, not the user record stored beside it", async () => {
    // A token for B stored beside A's user record: the database would answer as B.
    storage.setItem(authStorageKey(Y), JSON.stringify({ ...(JSON.parse(session(A)) as object), access_token: accessToken(B) }));
    const api = connect(Y);
    await expect(api.listSessions({ asUser: A })).rejects.toBeInstanceOf(ApiError);
    expect(restRequests()).toEqual([]);

    expect(jwtSubject(accessToken(A))).toBe(A);
    expect(jwtSubject("not-a-jwt")).toBeNull();
    expect(jwtSubject("a.%%%.c")).toBeNull();
    expect(jwtSubject(`a.${Buffer.from('{"sub":""}').toString("base64url")}.c`)).toBeNull();
  });

  it("fails closed when the token's sub can't be read, even beside A's user record (I1)", async () => {
    for (const token of ["opaque-token", `a.${Buffer.from('{"role":"authenticated"}').toString("base64url")}.c`]) {
      storage.setItem(authStorageKey(Y), session(A, 3600, token));
      const api = connect(Y);
      await expect(api.listSessions({ asUser: A })).rejects.toMatchObject({ code: "account_changed" });
      await expect(api.createHostPairing("Laptop", { asUser: A })).rejects.toMatchObject({ code: "account_changed" });
    }
    expect(restRequests()).toEqual([]);
  });

  describe("an expired sign-in whose refresh gets no answer (L4)", () => {
    beforeEach(() => {
      // auth-js retries a refresh that failed on the network or a 5xx with
      // backoff for up to ~13 s; only its sleeps (setTimeout) and clock are faked.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    for (const answer of ["network", 503, 500] as const) {
      it(`fails as unavailable, not expired, on ${answer === "network" ? "a network failure" : `a ${answer}`}, and sends nothing`, async () => {
        refreshAnswer = answer;
        storage.setItem(authStorageKey(Y), session(A, -60));
        const api = connect(Y);
        const result = api.listSessions({ asUser: A }).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await result).toMatchObject({ code: "unavailable", message: PROJECT_UNAVAILABLE_MESSAGE });
        expect(sent.some((r) => r.url.includes("/auth/v1/token"))).toBe(true);
        expect(restRequests()).toEqual([]);
        // The sign-in is kept for when the project answers again.
        expect(storage.getItem(authStorageKey(Y))).not.toBeNull();
      });
    }
  });

  it("leaves unpinned reads as they were", async () => {
    const api = await signedInAs(A);
    storage.setItem(authStorageKey(Y), session(B));
    await api.listSessions();
    expect(restRequests().map((r) => r.authorization)).toEqual([`Bearer ${accessToken(B)}`]);
  });

  it("demo: refuses a read pinned to anyone but its one user", async () => {
    const demo = createDemoApi({ tickMs: 0 });
    open.push(demo);
    const user = await demo.getUser();
    expect(user).not.toBeNull();
    await expect(demo.listSessions({ asUser: user?.id ?? "" })).resolves.toBeInstanceOf(Array);
    await expect(demo.listHosts({ asUser: B })).rejects.toMatchObject({ code: "account_changed" });
    await expect(demo.getNotificationPrefs({ asUser: B })).rejects.toMatchObject({ code: "account_changed" });
    for (const request of [
      () => demo.createHostPairing("Laptop", { asUser: B }),
      () => demo.revokeHost(HOST, { asUser: B }),
      () => demo.saveNotificationPrefs(DEFAULT_NOTIFICATION_PREFS, { asUser: B }),
      () => demo.getSession(HOST, { asUser: B }),
      () => demo.listEvents(HOST, 10, { asUser: B }),
      () => demo.listMessages(HOST, 10, { asUser: B }),
    ]) {
      await expect(request()).rejects.toMatchObject({ code: "account_changed" });
    }
  });
});
