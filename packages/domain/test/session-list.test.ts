import { describe, expect, it } from "vitest";
import { SESSION_LIST_LIMIT } from "@mc/contracts/constants";
import { NO_SESSION_LIST_GAPS, hasSessionListGaps, isKeyRejection, sessionListGapMessages } from "../src/index.js";

describe("sessionListGapMessages", () => {
  it("says nothing for a complete list", () => {
    expect(hasSessionListGaps(NO_SESSION_LIST_GAPS)).toBe(false);
    expect(sessionListGapMessages(NO_SESSION_LIST_GAPS)).toEqual([]);
  });

  it("names the cap and the unreadable rows, counts only", () => {
    expect(SESSION_LIST_LIMIT).toBe(500);
    expect(sessionListGapMessages({ truncated: true, dropped: 0 })).toEqual(["Showing the 500 most recent sessions; counts cover only these."]);
    expect(sessionListGapMessages({ truncated: false, dropped: 1 })).toEqual(["1 session couldn't be read and isn't shown."]);
    // Unreadable rows may leave fewer than the limit on screen, so exactly 20 is never claimed.
    expect(sessionListGapMessages({ truncated: true, dropped: 3 }, 20)).toEqual([
      "Showing the newest sessions (up to 20); counts cover only these.",
      "3 sessions couldn't be read and aren't shown.",
    ]);
    expect(hasSessionListGaps({ truncated: false, dropped: 2 })).toBe(true);
  });
});

describe("isKeyRejection (shared by the clients and the connector)", () => {
  const GATEWAY = { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." };

  it("matches only a 401 that names an API key", () => {
    expect(isKeyRejection(GATEWAY, 401)).toBe(true);
    expect(isKeyRejection({ message: "Unauthorized", hint: "Check your API key." }, 401)).toBe(true);
    expect(isKeyRejection(GATEWAY, 403)).toBe(false);
    expect(isKeyRejection({ message: "Invalid login credentials" }, 401)).toBe(false);
    expect(isKeyRejection(null, 401)).toBe(false);
  });

  it("lets a PostgREST JWT code win; without a code the text alone decides (the connector's calls)", () => {
    const text = { message: "No suitable API key or wrong key type" };
    expect(isKeyRejection({ ...text, code: "PGRST301" }, 401)).toBe(false);
    expect(isKeyRejection(text, 401)).toBe(true);
  });
});
