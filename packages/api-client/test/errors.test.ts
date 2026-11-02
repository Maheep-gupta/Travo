import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import { SESSION_EXPIRED_MESSAGE, toApiError } from "../src/supabase-api.js";

// Database text that must never reach the UI.
const RAW = "new row for relation \"hosts\" violates check constraint \"hosts_name_check\"";

function mapped(e: { code?: string; message?: string } | null, status?: number): { code: ApiError["code"]; message: string } {
  const err = toApiError(e, status);
  expect(err).toBeInstanceOf(ApiError);
  return { code: err.code, message: err.message };
}

describe("toApiError", () => {
  it("maps expired or rejected JWTs to unauthorized", () => {
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      expect(mapped({ code, message: "JWT expired" })).toEqual({ code: "unauthorized", message: SESSION_EXPIRED_MESSAGE });
    }
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your sign-in has expired. Please sign in again.");
  });

  it("maps any HTTP 401 and a 'JWT expired' message to unauthorized", () => {
    expect(mapped({ code: "XX000", message: RAW }, 401).code).toBe("unauthorized");
    expect(mapped({ message: "JWT expired" }).code).toBe("unauthorized");
    // Anonymous request after the session was dropped: authentication, not permission.
    expect(mapped({ code: "42501", message: RAW }, 401).code).toBe("unauthorized");
  });

  it("keeps 42501 from a signed-in request as forbidden", () => {
    expect(mapped({ code: "42501", message: RAW }, 403)).toEqual({ code: "forbidden", message: "You are not allowed to do that." });
    expect(mapped({ code: "42501", message: RAW }).code).toBe("forbidden");
  });

  it("maps PGRST116 to not_found", () => {
    expect(mapped({ code: "PGRST116", message: RAW }, 406)).toEqual({ code: "not_found", message: "Not found." });
  });

  it("maps invalid input to invalid without passing database text through", () => {
    for (const code of ["22023", "23514", "54000"]) {
      const r = mapped({ code, message: RAW }, 400);
      expect(r.code).toBe("invalid");
      expect(r.message).not.toMatch(/relation|constraint|hosts_name_check/);
      expect(r.message).not.toContain(RAW);
    }
    expect(mapped({ code: "54000", message: RAW }, 400).message).toBe("Too many pending pairings. Revoke unused hosts first.");
  });

  it("maps everything else to a generic unknown error", () => {
    // A 5xx without a database code is an outage (see availability.test.ts), so the codeless cases use a 4xx.
    for (const [e, status] of [[{ code: "23503", message: RAW }, 500], [{ message: RAW }, 400], [null, 400], [null, undefined]] as const) {
      const r = mapped(e, status);
      expect(r).toEqual({ code: "unknown", message: "The request failed. Check your connection and try again." });
    }
  });
});
