import { execFile } from "node:child_process";
import { z } from "zod";
import { mapClaudeAgentsStatus } from "@mc/domain";
import type { Provider, ProviderSession } from "../types.js";

/*
 * Read-only Claude Code provider built on `claude agents --json`.
 *
 * NOT ENABLED: the CLI and provider selection never construct this class while
 * REAL_ADAPTER_ENABLED is false (apps/connector/src/config.ts). It exists so its
 * behaviour can be unit-tested from recorded sample output before enabling.
 *
 * Content-free by design: no prompts, no transcripts, no full paths, and no
 * `messages()` method. Error messages never echo the command's output.
 */

// Contract limits from packages/contracts/src/session.ts (SessionRow).
const MAX_EXTERNAL_ID = 200;
const MAX_TITLE = 300;
const MAX_PROJECT_LABEL = 200;
const MAX_STATUS_REASON = 500;

/** Upper bounds for the default runner; callers may only lower them. */
export const CLAUDE_AGENTS_TIMEOUT_MS = 10_000;
export const CLAUDE_AGENTS_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * One entry of `claude agents --json`, as observed on CLI 2.1.312:
 * `pid`, `cwd`, `sessionId`, `name`, `status`. Unknown keys are stripped;
 * only `sessionId` is required; a wrongly typed `name`/`cwd` becomes null;
 * `status` stays untyped so unrecognised values map to "unknown" instead of
 * being rejected. Timestamp keys are not observed yet and are read only if present.
 */
const AgentEntry = z.object({
  sessionId: z.string().trim().min(1).max(MAX_EXTERNAL_ID),
  status: z.unknown(),
  name: z.unknown().optional(),
  cwd: z.unknown().optional(),
  lastActivityAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
});
type AgentEntry = z.infer<typeof AgentEntry>;

export type ClaudeAgentsParseResult =
  | { ok: true; sessions: ProviderSession[]; skipped: number }
  | { ok: false; sessions: []; skipped: 0; reason: string };

/**
 * Parses `claude agents --json` stdout. Never throws. Malformed entries are
 * skipped and counted; non-JSON, non-array or empty output is reported as a
 * failure with a fixed, content-free `reason` that is safe to log.
 */
export function parseClaudeAgentsOutput(stdout: string, now: Date): ClaudeAgentsParseResult {
  if (stdout.trim() === "") return fail("claude agents --json produced no output.");
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return fail("claude agents --json output was not valid JSON.");
  }
  if (!Array.isArray(raw)) return fail("claude agents --json output was not a JSON array.");

  const sessions: ProviderSession[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of raw) {
    const parsed = AgentEntry.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.sessionId)) {
      skipped += 1;
      continue;
    }
    seen.add(parsed.data.sessionId);
    sessions.push(toProviderSession(parsed.data, now));
  }
  return { ok: true, sessions, skipped };
}

/** Convenience form: the sessions only, `[]` on any failure. */
export function parseClaudeAgentsJson(stdout: string, now: Date): ProviderSession[] {
  return parseClaudeAgentsOutput(stdout, now).sessions;
}

function fail(reason: string): ClaudeAgentsParseResult {
  return { ok: false, sessions: [], skipped: 0, reason };
}

function toProviderSession(entry: AgentEntry, now: Date): ProviderSession {
  const mapped = mapClaudeAgentsStatus(entry.status);
  const lastActivity =
    mapped.status === "running" ? now.toISOString() : (parseTimestamp(entry.lastActivityAt ?? entry.updatedAt, now) ?? null);
  return {
    external_id: entry.sessionId,
    title: cleanText(entry.name, MAX_TITLE),
    project_label: projectLabelFromCwd(entry.cwd),
    status: mapped.status,
    status_reason: mapped.reason.slice(0, MAX_STATUS_REASON),
    last_activity_at: lastActivity,
    last_event_summary: null,
    started_at: null,
  };
}

/** Strips control characters, collapses whitespace and caps length; empty becomes null. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned.slice(0, max);
}

const HOME_PARENTS: ReadonlySet<string> = new Set(["home", "users"]);

/**
 * Only the last path segment of a working directory, never the full path.
 * Handles POSIX and Windows separators. Returns null for roots, bare drive
 * letters and home directories themselves (`/home/<user>`, `C:\Users\<user>`,
 * `/mnt/c/Users/<user>`, `/root`), whose last segment would be the account name.
 */
export function projectLabelFromCwd(cwd: unknown): string | null {
  if (typeof cwd !== "string") return null;
  const segments = cwd.split(/[\\/]+/).filter((s) => s !== "");
  const last = segments.at(-1);
  if (last === undefined || /^[A-Za-z]:$/.test(last)) return null;
  const parent = segments.at(-2);
  const isHomeDir =
    (parent !== undefined && HOME_PARENTS.has(parent.toLowerCase())) || (segments.length === 1 && last === "root");
  if (isHomeDir) return null;
  return cleanText(last, MAX_PROJECT_LABEL);
}

/** Accepts ISO strings or epoch milliseconds; never later than `now`. */
function parseTimestamp(value: unknown, now: Date): string | null {
  let ms: number;
  if (typeof value === "string") ms = Date.parse(value);
  else if (typeof value === "number") ms = value;
  else return null;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(Math.min(ms, now.getTime())).toISOString();
}

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

export type CommandRunner = () => Promise<CommandResult>;

export type ClaudeCommandFailure = "not_found" | "timeout" | "output_too_large" | "spawn_failed";

const FAILURE_MESSAGE: Record<ClaudeCommandFailure, string> = {
  not_found: "claude CLI was not found on PATH.",
  timeout: "claude agents --json timed out.",
  output_too_large: "claude agents --json output exceeded the size limit.",
  spawn_failed: "claude agents --json could not be started.",
};

/** A runner failure whose message is fixed text, safe to log. */
export class ClaudeCommandError extends Error {
  constructor(readonly kind: ClaudeCommandFailure) {
    super(FAILURE_MESSAGE[kind]);
    this.name = "ClaudeCommandError";
  }
}

export interface ClaudeAgentsRunnerOptions {
  /** Executable to run. Default "claude". */
  command?: string;
  /** Capped at CLAUDE_AGENTS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Capped at CLAUDE_AGENTS_MAX_BUFFER_BYTES. */
  maxBufferBytes?: number;
}

/**
 * Runs `claude agents --json` with execFile (no shell). A non-zero exit
 * resolves with its exit code; spawn failures, timeouts and oversized output
 * reject with a ClaudeCommandError. stderr is discarded, never surfaced.
 */
export function createClaudeAgentsRunner(opts: ClaudeAgentsRunnerOptions = {}): CommandRunner {
  const command = opts.command ?? "claude";
  const timeout = Math.min(opts.timeoutMs ?? CLAUDE_AGENTS_TIMEOUT_MS, CLAUDE_AGENTS_TIMEOUT_MS);
  const maxBuffer = Math.min(opts.maxBufferBytes ?? CLAUDE_AGENTS_MAX_BUFFER_BYTES, CLAUDE_AGENTS_MAX_BUFFER_BYTES);
  return () =>
    new Promise<CommandResult>((resolve, reject) => {
      execFile(
        command,
        ["agents", "--json"],
        { timeout, maxBuffer, windowsHide: true, encoding: "utf8", shell: false },
        (error, stdout) => {
          if (!error) return resolve({ stdout, exitCode: 0 });
          const code = (error as NodeJS.ErrnoException).code as unknown;
          if (code === "ENOENT") return reject(new ClaudeCommandError("not_found"));
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new ClaudeCommandError("output_too_large"));
          if (error.killed || error.signal) return reject(new ClaudeCommandError("timeout"));
          if (typeof code === "number") return resolve({ stdout, exitCode: code });
          return reject(new ClaudeCommandError("spawn_failed"));
        },
      );
    });
}

export interface ClaudeCodeProviderOptions {
  runCommand: CommandRunner;
  now?: () => Date;
  /** Receives content-free notes, e.g. how many entries were skipped. */
  log?: (line: string) => void;
}

/**
 * Lists live Claude Code sessions. poll() rejects with a sanitised Error on any
 * failure so the connector's offline/backoff handling applies and no session is
 * wrongly marked ended because of one bad read.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude-code" as const;
  readonly isDemo = false;
  private readonly runCommand: CommandRunner;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(opts: ClaudeCodeProviderOptions) {
    this.runCommand = opts.runCommand;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  async poll(): Promise<ProviderSession[]> {
    let result: CommandResult;
    try {
      result = await this.runCommand();
    } catch (e) {
      // Only fixed texts leave this method; arbitrary error messages may embed output,
      // so the original error is deliberately not attached as `cause`.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(e instanceof ClaudeCommandError ? e.message : FAILURE_MESSAGE.spawn_failed);
    }
    if (result.exitCode !== 0) {
      const code = Number.isInteger(result.exitCode) ? result.exitCode : "unknown";
      throw new Error(`claude agents --json exited with code ${code}.`);
    }
    const parsed = parseClaudeAgentsOutput(result.stdout, this.now());
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.skipped > 0) this.log(`claude-code: skipped ${parsed.skipped} malformed or duplicate session entr${parsed.skipped === 1 ? "y" : "ies"}.`);
    return parsed.sessions;
  }
}
