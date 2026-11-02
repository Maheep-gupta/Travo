// Telling a rejected publishable key (L1) and an unreachable project apart
// from an expired or failed sign-in, through the real supabase-js stack where
// possible. Response bodies are matched, never shown.
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldRetryFetch } from "@mc/domain";
import { ApiError } from "../src/api.js";
import { MemoryStorage } from "../src/storage.js";
import {
  KEY_REJECTED_MESSAGE,
  PROJECT_UNAVAILABLE_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  createSupabaseApi,
  isKeyRejection,
  toApiError,
  toSignInError,
} from "../src/supabase-api.js";

// What the API gateway answers for an unknown or revoked key.
const GATEWAY_BODY = { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." };

describe("isKeyRejection", () => {
  it("matches a gateway 401 that names the API key, in the message or the hint", () => {
    expect(isKeyRejection(GATEWAY_BODY, 401)).toBe(true);
    expect(isKeyRejection({ message: "Unregistered API key" }, 401)).toBe(true);
    expect(isKeyRejection({ message: "Unauthorized", hint: "No `apikey` request header or url param was found. Check your API key." }, 401)).toBe(true);
  });

  it("does not match an expired or invalid user token, or anything but a 401", () => {
    expect(isKeyRejection({ code: "PGRST301", message: "JWT expired" }, 401)).toBe(false);
    // A JWT code wins even if some text mentions a key.
    expect(isKeyRejection({ code: "PGRST301", message: "No suitable API key or wrong key type" }, 401)).toBe(false);
    expect(isKeyRejection({ message: "Invalid login credentials" }, 400)).toBe(false);
    expect(isKeyRejection(GATEWAY_BODY, 403)).toBe(false);
    expect(isKeyRejection(GATEWAY_BODY)).toBe(false);
    expect(isKeyRejection(null, 401)).toBe(false);
  });
});

describe("toApiError for a rejected key", () => {
  it("maps it to misconfigured, without the response text", () => {
    const err = toApiError(GATEWAY_BODY, 401);
    expect(err).toMatchObject({ code: "misconfigured", message: KEY_REJECTED_MESSAGE });
    expect(err.message).not.toMatch(/service_role|anon|Double check/);
  });

  it("still maps an expired sign-in to unauthorized", () => {
    expect(toApiError({ code: "PGRST303", message: "JWT expired" }, 401)).toMatchObject({ code: "unauthorized", message: SESSION_EXPIRED_MESSAGE });
    expect(toApiError({ code: "42501", message: "permission denied" }, 401).code).toBe("unauthorized");
  });
});

describe("toSignInError", () => {
  it("blames the email and password only for a genuine rejection", () => {
    const wrong = toSignInError(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    expect(wrong).toMatchObject({ code: "unauthorized", message: "Sign-in failed. Check your email and password." });
  });

  it("reports an unreachable project, a rejected key and a rate limit as such", () => {
    expect(toSignInError(new AuthRetryableFetchError("Failed to fetch", 0))).toMatchObject({ code: "unavailable", message: PROJECT_UNAVAILABLE_MESSAGE });
    expect(toSignInError(new AuthRetryableFetchError("Bad Gateway", 502)).code).toBe("unavailable");
    expect(toSignInError(new AuthUnknownError("Unexpected token <", null)).code).toBe("unavailable");
    expect(toSignInError(new AuthApiError("Invalid API key", 401, undefined))).toMatchObject({ code: "misconfigured", message: KEY_REJECTED_MESSAGE });
    const limited = toSignInError(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"));
    expect(limited.message).toMatch(/Too many sign-in attempts/);
    // Its own code: "unavailable" counts as transient and would be retried.
    expect(limited.code).toBe("rate_limited");
    expect(shouldRetryFetch(0, limited)).toBe(false);
  });

  it("never passes Auth's own text through", () => {
    for (const e of [new AuthApiError("Email not confirmed <secret detail>", 400, "email_not_confirmed"), new AuthRetryableFetchError("proxy said <secret detail>", 0)]) {
      expect(toSignInError(e).message).not.toContain("secret detail");
    }
  });
});

describe("createSupabaseApi with a rejected publishable key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(respond: (url: string) => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => respond(String(input instanceof Request ? input.url : input))));
    return createSupabaseApi({ url: "https://example.supabase.co", publishableKey: "sb_publishable_0123456789abcdef" }, new MemoryStorage());
  }

  const json = (body: unknown, status: number) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("says the key was rejected on startup, on data reads and on sign-in, instead of 'expired' or 'wrong password'", async () => {
    const api = stubFetch(() => json(GATEWAY_BODY, 401));
    await expect(api.getSchemaVersion()).rejects.toMatchObject({ code: "misconfigured", message: KEY_REJECTED_MESSAGE });
    await expect(api.listHosts()).rejects.toMatchObject({ code: "misconfigured" });
    const signIn = await api.signIn("a@example.test", "pw").catch((e: unknown) => e);
    expect(signIn).toBeInstanceOf(ApiError);
    expect(signIn).toMatchObject({ code: "misconfigured", message: KEY_REJECTED_MESSAGE });
  });

  it("keeps 'check your email and password' for rejected credentials and says 'can't reach' when offline", async () => {
    const wrong = stubFetch(() => json({ code: "invalid_credentials", msg: "Invalid login credentials" }, 400));
    await expect(wrong.signIn("a@example.test", "pw")).rejects.toMatchObject({ code: "unauthorized", message: "Sign-in failed. Check your email and password." });

    const offline = stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(offline.signIn("a@example.test", "pw")).rejects.toMatchObject({ code: "unavailable", message: PROJECT_UNAVAILABLE_MESSAGE });
  });
});
