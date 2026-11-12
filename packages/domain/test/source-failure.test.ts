import { PROVIDER_ERROR_KINDS } from "@mc/contracts/constants";
import { describe, expect, it } from "vitest";
import { sourceFailureText } from "../src/source-failure.js";

describe("sourceFailureText", () => {
  it("says what is wrong and what to do for every category", () => {
    const titles = new Set<string>();
    for (const kind of PROVIDER_ERROR_KINDS) {
      const t = sourceFailureText(kind);
      expect(t.kind).toBe(kind);
      expect(t.title.length).toBeGreaterThan(10);
      expect(t.guidance.length).toBeGreaterThan(20);
      titles.add(t.title);
    }
    expect(titles.size).toBe(PROVIDER_ERROR_KINDS.length); // each one distinct
  });

  it("names the missing CLI and how to fix it", () => {
    expect(sourceFailureText("cli_missing")).toMatchObject({
      title: "Claude Code CLI not found on this computer",
      guidance: expect.stringContaining("PATH"),
    });
    expect(sourceFailureText("auth_required").guidance).toContain("run claude to sign in");
    expect(sourceFailureText("writes_not_applied").guidance).toContain("clock");
  });

  it("leads with the effect: refused updates aren't described as a failed read", () => {
    expect(sourceFailureText("writes_not_applied").summary).toBe("The host's session updates aren't being saved");
    for (const kind of PROVIDER_ERROR_KINDS.filter((k) => k !== "writes_not_applied")) {
      expect(sourceFailureText(kind).summary).toBe("The host can't read its sessions");
    }
  });

  it("is plain text: no markdown backticks for clients to show literally", () => {
    for (const kind of [...PROVIDER_ERROR_KINDS, null]) {
      const t = sourceFailureText(kind);
      expect(`${t.summary}${t.title}${t.guidance}`).not.toContain("`");
    }
  });

  it("falls back to a generic message for a missing or unknown category, never echoing it", () => {
    const generic = sourceFailureText(null);
    expect(generic).toEqual({ kind: null, summary: "The host can't read its sessions", title: "The connector didn't report why", guidance: expect.stringContaining("doctor") });
    expect(sourceFailureText(undefined)).toEqual(generic);
    const odd = sourceFailureText("<script>alert(1)</script>");
    expect(odd).toEqual(generic);
    expect(JSON.stringify(odd)).not.toContain("script");
    expect(sourceFailureText("toString")).toEqual(generic); // not an inherited property
  });
});
