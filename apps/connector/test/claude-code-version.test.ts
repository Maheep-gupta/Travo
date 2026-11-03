import { describe, expect, it } from "vitest";
import {
  LAST_OBSERVED_CLAUDE_VERSION,
  MAX_SUPPORTED_CLAUDE_VERSION_EXCLUSIVE,
  MIN_SUPPORTED_CLAUDE_VERSION,
  claudeVersionCompatibility,
  formatClaudeVersion,
  parseClaudeVersion,
  requireCompatibleClaudeVersion,
} from "../src/providers/claude-code-version.js";

// SYNTHETIC version strings shaped like the one observation recorded (2.1.312).

describe("parseClaudeVersion", () => {
  it.each([
    ["2.1.312 (Claude Code)", { major: 2, minor: 1, patch: 312 }],
    ["2.1.312 (Claude Code)\n", { major: 2, minor: 1, patch: 312 }],
    [`${String.fromCharCode(0xfeff)} 2.10.0 (Claude Code) \r\n`, { major: 2, minor: 10, patch: 0 }],
  ])("%j", (stdout, version) => {
    expect(parseClaudeVersion(stdout)).toEqual(version);
  });

  it.each([
    [""],
    ["2.1.312"],
    ["v2.1.312 (Claude Code)"],
    ["2.1 (Claude Code)"],
    ["2.1.312-beta (Claude Code)"],
    ["2.1.312 (Claude Desktop)"],
    ["2.1.312 (Claude Code)\nUpdate available"],
    ["v24.19.0"],
    ["99999.1.1 (Claude Code)"],
  ])("refuses to guess %j", (stdout) => {
    expect(parseClaudeVersion(stdout)).toBeNull();
  });
});

describe("compatibility", () => {
  it("has a consistent range", () => {
    expect(claudeVersionCompatibility(MIN_SUPPORTED_CLAUDE_VERSION)).toBe("supported");
    expect(claudeVersionCompatibility(LAST_OBSERVED_CLAUDE_VERSION)).toBe("supported");
    expect(claudeVersionCompatibility(MAX_SUPPORTED_CLAUDE_VERSION_EXCLUSIVE)).toBe("too_new");
  });

  it.each([
    ["2.1.311", "too_old"],
    ["1.99.999", "too_old"],
    ["2.1.312", "supported"],
    ["2.1.313", "newer_than_observed"],
    ["2.99.0", "newer_than_observed"],
    ["3.0.0", "too_new"],
    ["10.0.0", "too_new"],
  ])("%s is %s", (v, expected) => {
    const [major, minor, patch] = v.split(".").map(Number) as [number, number, number];
    expect(claudeVersionCompatibility({ major, minor, patch })).toBe(expected);
  });

  it("throws fixed, rebuilt messages", () => {
    expect(() => requireCompatibleClaudeVersion("garbage SYNTHETIC-SECRET-MARKER")).toThrow(
      "claude --version output was not recognised as Claude Code; the format is not guessed.",
    );
    expect(() => requireCompatibleClaudeVersion("3.0.1 (Claude Code)")).toThrow("Claude Code 3.0.1 is newer than the supported range (below 3.0.0).");
    expect(requireCompatibleClaudeVersion("2.1.312 (Claude Code)")).toEqual({ version: MIN_SUPPORTED_CLAUDE_VERSION, compatibility: "supported" });
    expect(formatClaudeVersion({ major: 2, minor: 1, patch: 312 })).toBe("2.1.312");
  });
});
