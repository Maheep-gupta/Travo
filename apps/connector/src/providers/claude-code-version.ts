import { ClaudeCommandError } from "./claude-code-process.js";

/*
 * Version compatibility for the Claude Code provider.
 *
 * `claude --version` must print exactly `<major>.<minor>.<patch> (Claude Code)`.
 * Anything else (another program called `claude`, a new format, extra lines)
 * is "unrecognised" and the provider reports its source as unavailable rather
 * than guessing how to read `claude agents --json`.
 *
 * UNVERIFIED against a live CLI. The only observation recorded so far is
 * 2.1.312 (docs/INTEGRATIONS.md); both bounds are updated by the live checklist.
 */

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Oldest version whose `agents --json` output has been observed. */
export const MIN_SUPPORTED_CLAUDE_VERSION: ClaudeVersion = { major: 2, minor: 1, patch: 312 };
/** First version assumed incompatible: a new major may change the command or its output. */
export const MAX_SUPPORTED_CLAUDE_VERSION_EXCLUSIVE: ClaudeVersion = { major: 3, minor: 0, patch: 0 };
/** Newest version actually observed; newer ones inside the range work but are logged once. */
export const LAST_OBSERVED_CLAUDE_VERSION: ClaudeVersion = { major: 2, minor: 1, patch: 312 };

/** Byte-order mark, built from its code point so the source stays plain ASCII. */
const BOM = String.fromCharCode(0xfeff);
const VERSION_LINE =/^(\d{1,4})\.(\d{1,4})\.(\d{1,6}) \(Claude Code\)$/;

/** Parses `claude --version` stdout; null unless it is exactly the expected one line. */
export function parseClaudeVersion(stdout: string): ClaudeVersion | null {
  const text = stdout.startsWith(BOM) ? stdout.slice(1) : stdout;
  const m = VERSION_LINE.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatClaudeVersion(v: ClaudeVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareClaudeVersions(a: ClaudeVersion, b: ClaudeVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export type VersionCompatibility = "supported" | "newer_than_observed" | "too_old" | "too_new";

export function claudeVersionCompatibility(v: ClaudeVersion): VersionCompatibility {
  if (compareClaudeVersions(v, MIN_SUPPORTED_CLAUDE_VERSION) < 0) return "too_old";
  if (compareClaudeVersions(v, MAX_SUPPORTED_CLAUDE_VERSION_EXCLUSIVE) >= 0) return "too_new";
  if (compareClaudeVersions(v, LAST_OBSERVED_CLAUDE_VERSION) > 0) return "newer_than_observed";
  return "supported";
}

/**
 * Parses and checks a version in one step. Throws a ClaudeCommandError
 * (version_unrecognised / version_too_old / version_too_new) whose message
 * holds only the rebuilt version and our own bounds.
 */
export function requireCompatibleClaudeVersion(stdout: string): { version: ClaudeVersion; compatibility: "supported" | "newer_than_observed" } {
  const version = parseClaudeVersion(stdout);
  if (!version) throw new ClaudeCommandError("version_unrecognised", "version");
  const compatibility = claudeVersionCompatibility(version);
  if (compatibility === "too_old") {
    throw new ClaudeCommandError("version_too_old", "version", {
      version: formatClaudeVersion(version),
      bound: formatClaudeVersion(MIN_SUPPORTED_CLAUDE_VERSION),
    });
  }
  if (compatibility === "too_new") {
    throw new ClaudeCommandError("version_too_new", "version", {
      version: formatClaudeVersion(version),
      bound: formatClaudeVersion(MAX_SUPPORTED_CLAUDE_VERSION_EXCLUSIVE),
    });
  }
  return { version, compatibility };
}
