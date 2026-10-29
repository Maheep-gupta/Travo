import { describe, expect, it } from "vitest";
import { ConnectionConfig } from "@mc/api-client/connection";
import { fieldErrors, firstInvalidField } from "./form-errors.js";

const FIELDS = ["url", "publishableKey"] as const;

describe("fieldErrors", () => {
  it("attaches each message to its field, keeping the first per field", () => {
    const errors = fieldErrors(
      [
        { path: ["publishableKey"], message: "short" },
        { path: ["publishableKey"], message: "second" },
        { path: ["url"], message: "bad url" },
      ],
      FIELDS,
    );
    expect(errors).toEqual({ publishableKey: "short", url: "bad url" });
    expect(firstInvalidField(errors, FIELDS)).toBe("url");
  });

  it("puts issues without a known field at form level", () => {
    expect(fieldErrors([{ path: [], message: "whole form" }, { path: ["other"], message: "x" }], FIELDS)).toEqual({ form: "whole form" });
    expect(firstInvalidField({ form: "whole form" }, FIELDS)).toBeNull();
  });

  it("maps real connection-settings issues, including privileged-key rejection, to the key field", () => {
    const parsed = ConnectionConfig.safeParse({ url: "http://example.com", publishableKey: "sb_secret_abcdefghijklmnopqrstuvwxyz" });
    expect(parsed.success).toBe(false);
    const errors = fieldErrors(parsed.error?.issues ?? [], FIELDS);
    expect(errors.url).toMatch(/https/);
    expect(errors.publishableKey).toMatch(/secret/);
  });
});
