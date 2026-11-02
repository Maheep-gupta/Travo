// Backend availability (spec Part 16): an unreachable or paused Supabase
// project is told apart from auth and query errors, response bodies never reach
// the error, and supabase-js doesn't retry on top of the query client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { MemoryStorage } from "../src/storage.js";
import { PROJECT_PAUSED_MESSAGE, PROJECT_PAUSED_STATUS, PROJECT_UNAVAILABLE_MESSAGE, createSupabaseApi, toApiError } from "../src/supabase-api.js";

const BODY = '{"message":"relation \\"hosts\\" is on fire","code":"XX000"}';

describe("toApiError availability", () => {
  it("maps HTTP 540 to paused, whatever the body says", () => {
    expect(PROJECT_PAUSED_STATUS).toBe(540);
    for (const e of [{ message: BODY }, { code: "", message: "" }, null]) {
      const err = toApiError(e, 540);
      expect(err).toMatchObject({ code: "paused", message: PROJECT_PAUSED_MESSAGE });
    }
    expect(PROJECT_PAUSED_MESSAGE).toMatch(/Restore it .*Supabase dashboard/);
  });

  it("maps no response, gateway errors and database-connection failures to unavailable", () => {
    const cases: [{ code?: string; message?: string } | null, number][] = [
      // supabase-js after a failed fetch: network error, timeout, or a CORS-blocked answer.
      [{ code: "", message: "TypeError: Failed to fetch" }, 0],
      [{ message: "<html>Bad Gateway</html>" }, 502],
      [{ message: "" }, 503],
      [{ message: "" }, 504],
      [{ message: "" }, 520],
      [{ message: "" }, 522],
      [{ message: "" }, 544],
      [{ code: "PGRST000", message: "Could not connect with the database" }, 503],
      [{ code: "PGRST003", message: "Timed out acquiring connection" }, 504],
      [{ message: BODY }, 500],
    ];
    for (const [e, status] of cases) {
      expect(toApiError(e, status)).toMatchObject({ code: "unavailable", message: PROJECT_UNAVAILABLE_MESSAGE });
    }
    expect(PROJECT_UNAVAILABLE_MESSAGE).toMatch(/may be paused/);
  });

  it("keeps auth and query errors apart from unavailability", () => {
    expect(toApiError({ code: "PGRST301", message: "JWT expired" }, 401).code).toBe("unauthorized");
    expect(toApiError({ code: "42501", message: BODY }, 403).code).toBe("forbidden");
    expect(toApiError({ code: "23503", message: BODY }, 500).code).toBe("unknown");
    expect(toApiError({ code: "22023", message: BODY }, 400).code).toBe("invalid");
  });

  it("never carries the response body", () => {
    for (const status of [0, 500, 502, 540]) {
      const err = toApiError({ message: BODY, code: "" }, status);
      expect(err.message).not.toMatch(/relation|fire|XX000/);
    }
  });
});

describe("createSupabaseApi against an unavailable project", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(respond: () => Promise<Response>) {
    const fetchMock = vi.fn(respond);
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, api: createSupabaseApi({ url: "https://example.supabase.co", publishableKey: "sb_publishable_0123456789abcdef" }, new MemoryStorage()) };
  }

  const rest = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([input]) => String(input).includes("/rest/v1/"));

  it("reports a paused project", async () => {
    const { api, fetchMock } = stubFetch(() => Promise.resolve(new Response("project paused", { status: 540 })));
    const err = await api.listHosts().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "paused" });
    await expect(api.getSchemaVersion()).rejects.toMatchObject({ code: "paused" });
    expect(rest(fetchMock)).toHaveLength(2);
  });

  it("makes one request per call on a 503 or a network failure (the query client owns retries)", async () => {
    const down = stubFetch(() => Promise.resolve(new Response("", { status: 503 })));
    await expect(down.api.listSessions()).rejects.toMatchObject({ code: "unavailable" });
    expect(rest(down.fetchMock)).toHaveLength(1);

    const offline = stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(offline.api.listHosts()).rejects.toMatchObject({ code: "unavailable" });
    expect(rest(offline.fetchMock)).toHaveLength(1);
    await expect(offline.api.getSchemaVersion()).rejects.toMatchObject({ code: "unavailable", message: PROJECT_UNAVAILABLE_MESSAGE });
  });

  // QA LOW-5: a refused sign-in or permission at startup isn't an outage or a pause.
  it("doesn't blame reachability for an auth, permission or rate-limit answer to the schema check", async () => {
    const json = (status: number, body: object) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    const cases: [() => Promise<Response>, string][] = [
      [json(401, { code: "PGRST301", message: "JWT expired" }), "unauthorized"],
      [json(403, { code: "42501", message: "permission denied for table app_meta" }), "forbidden"],
      [json(403, { message: "forbidden" }), "forbidden"],
      [json(401, { message: "Invalid API key" }), "misconfigured"],
      [json(429, { message: "Too many requests" }), "rate_limited"],
    ];
    for (const [respond, code] of cases) {
      const { api } = stubFetch(respond);
      const err = (await api.getSchemaVersion().catch((e: unknown) => e)) as ApiError;
      expect(err).toMatchObject({ code });
      expect(err.message).not.toBe(PROJECT_UNAVAILABLE_MESSAGE);
      expect(err.message).not.toMatch(/app_meta|permission denied/);
    }
  });
});
