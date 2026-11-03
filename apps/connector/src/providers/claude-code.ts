import { userInfo } from "node:os";
import { z } from "zod";
import type { SessionStatus } from "@mc/contracts";
import { mapClaudeAgentsStatus } from "@mc/domain";
import type { Provider, ProviderFailureCategory, ProviderSession } from "../types.js";
import { ClaudeCommandError, createClaudeAgentsRunner, createClaudeVersionRunner, type ClaudeCommandFailure, type ClaudeRunnerOptions, type CommandResult, type CommandRunner } from "./claude-code-process.js";
import { formatClaudeVersion, requireCompatibleClaudeVersion, type VersionCompatibility } from "./claude-code-version.js";

export {
  CLAUDE_AGENTS_MAX_BUFFER_BYTES,
  CLAUDE_AGENTS_TIMEOUT_MS,
  ClaudeCommandError,
  createClaudeAgentsRunner,
  createClaudeVersionRunner,
  type ClaudeCommandFailure,
  type ClaudeRunnerOptions,
  type CommandResult,
  type CommandRunner,
} from "./claude-code-process.js";

/*
 * Read-only Claude Code provider built on `claude --version` and
 * `claude agents --json`.
 *
 * NOT ENABLED: the CLI and provider selection never construct this class while
 * REAL_ADAPTER_ENABLED is false (apps/connector/src/config.ts). It exists so its
 * behaviour can be unit-tested from synthetic sample output before enabling.
 *
 * Content-free by design: no prompts, no transcripts, no full paths, and no
 * `messages()` method. Session titles from the CLI are opt-in (titlePolicy),
 * because they may be derived from prompt text (D-004, D-013). Error messages
 * never echo the command's output.
 */

// Contract limits from packages/contracts/src/session.ts (SessionRow).
const MAX_EXTERNAL_ID = 200;
const MAX_TITLE = 300;
const MAX_PROJECT_LABEL = 200;
const MAX_STATUS_REASON = 500;

/** How often a working provider re-reads `claude --version` (auto-updates replace the binary). */
export const VERSION_RECHECK_MS = 10 * 60_000;

/**
 * Where a session's title comes from.
 * - "generated" (default): `Session <last 8 characters of the id>`. Content-free.
 *   The tail, not the head: in time-ordered ids (e.g. UUIDv7) the head is a
 *   timestamp, so sessions started together would share a label.
 * - "cli_name": the CLI's `name` field, cleaned and capped. Claude Code may
 *   derive it from the first prompt, so it can carry prompt text off the
 *   machine; only for a user who has opted in.
 */
export type ClaudeTitlePolicy = "generated" | "cli_name";
export const DEFAULT_CLAUDE_TITLE_POLICY: ClaudeTitlePolicy = "generated";

/*
 * Session ids are used verbatim as external_id: the same id on every run is
 * what keeps a session's identity (and its events) stable across polls and
 * connector restarts. `pid` is deliberately ignored; it changes on resume.
 * Ids must be printable ASCII without spaces: no trimming or truncation,
 * because either could merge two sessions into one.
 */
const SessionId = z.string().min(1).max(MAX_EXTERNAL_ID).regex(/^[\x21-\x7e]+$/);

/**
 * One entry of `claude agents --json`, as observed on CLI 2.1.312:
 * `pid`, `cwd`, `sessionId`, `name`, `status`. Unknown keys are stripped;
 * only `sessionId` is required; a wrongly typed `name`/`cwd` becomes null;
 * `status` stays untyped so unrecognised values map to "unknown" instead of
 * being rejected. Timestamp keys are not observed yet and are read only if present.
 */
const AgentEntry = z.object({
  sessionId: SessionId,
  status: z.unknown(),
  name: z.unknown().optional(),
  cwd: z.unknown().optional(),
  lastActivityAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
});
type AgentEntry = z.infer<typeof AgentEntry>;

type OutputFailure = Extract<ClaudeCommandFailure, "empty_output" | "invalid_json" | "not_array" | "unrecognised_entries" | "unidentified_entries">;

export type ClaudeAgentsParseResult =
  | { ok: true; sessions: ProviderSession[]; skipped: number }
  | { ok: false; sessions: []; skipped: 0; kind: OutputFailure; reason: string };

export interface ClaudeAgentsParseOptions {
  titlePolicy?: ClaudeTitlePolicy;
  /** The local account name, never sent as a project label. Default: os.userInfo().username. */
  username?: string | null;
}

/**
 * Parses `claude agents --json` stdout. Never throws. Non-JSON, non-array or
 * empty output, a non-empty list in which no entry is recognisable (a changed
 * format), and a list with any entry that can't be identified, are reported as
 * a failure with a fixed, content-free `reason` that is safe to log. A failure
 * must never be read as "no sessions": that would mark every session ended.
 * The same holds for one unidentifiable entry: it may be a known session, and
 * leaving it out would mark that session ended (missing data is not negative
 * evidence, spec 4.1/4.2). Only duplicate ids are skipped and counted.
 */
export function parseClaudeAgentsOutput(stdout: string, now: Date, opts: ClaudeAgentsParseOptions = {}): ClaudeAgentsParseResult {
  const text = stdout.replace(/^\uFEFF/, "");
  if (text.trim() === "") return fail("empty_output");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  if (!Array.isArray(raw)) return fail("not_array");

  const titlePolicy = opts.titlePolicy ?? DEFAULT_CLAUDE_TITLE_POLICY;
  const username = opts.username === undefined ? localUsername() : opts.username;
  const sessions: ProviderSession[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let unidentified = 0;
  for (const item of raw) {
    const parsed = AgentEntry.safeParse(item);
    if (!parsed.success) {
      skipped += 1;
      unidentified += 1;
      continue;
    }
    if (seen.has(parsed.data.sessionId)) {
      skipped += 1;
      continue;
    }
    seen.add(parsed.data.sessionId);
    sessions.push(toProviderSession(parsed.data, now, titlePolicy, username));
  }
  if (raw.length > 0 && unidentified === raw.length) return fail("unrecognised_entries");
  if (unidentified > 0) return fail("unidentified_entries");
  return { ok: true, sessions, skipped };
}

/** Convenience form: the sessions only, `[]` on any failure. */
export function parseClaudeAgentsJson(stdout: string, now: Date, opts: ClaudeAgentsParseOptions = {}): ProviderSession[] {
  return parseClaudeAgentsOutput(stdout, now, opts).sessions;
}

function fail(kind: OutputFailure): ClaudeAgentsParseResult {
  return { ok: false, sessions: [], skipped: 0, kind, reason: new ClaudeCommandError(kind, "agents").message };
}

/** The content-free title used by the "generated" policy. */
export function generatedSessionTitle(sessionId: string): string {
  return `Session ${sessionId.slice(-8)}`;
}

function toProviderSession(entry: AgentEntry, now: Date, titlePolicy: ClaudeTitlePolicy, username: string | null): ProviderSession {
  const mapped = mapClaudeAgentsStatus(entry.status);
  const lastActivity =
    mapped.status === "running" ? now.toISOString() : (parseTimestamp(entry.lastActivityAt ?? entry.updatedAt, now) ?? null);
  return {
    external_id: entry.sessionId,
    title: titlePolicy === "cli_name" ? cleanText(entry.name, MAX_TITLE) : generatedSessionTitle(entry.sessionId),
    project_label: projectLabelFromCwd(entry.cwd, username),
    status: mapped.status,
    // Fixed texts from the domain mapping; never the raw CLI value.
    status_reason: mapped.reason.slice(0, MAX_STATUS_REASON),
    last_activity_at: lastActivity,
    last_event_summary: null,
    started_at: null,
  };
}

/*
 * C0/C1 controls, DEL, zero-width characters, bidi embeddings/overrides/
 * isolates, line/paragraph separators, and characters that render as nothing
 * or are used to smuggle text: the combining grapheme joiner, Hangul and
 * Khmer fillers, variation selectors, interlinear annotation marks and tag
 * characters (ASCII hidden in U+E0000–E007F). Bidi controls can make a title
 * read differently from what it contains (Trojan Source style).
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Strips invisible and control characters and lone surrogates, collapses
 * whitespace and caps length without splitting a surrogate pair (a lone
 * surrogate would make the whole upsert fail as invalid JSON in Postgres).
 * Empty becomes null.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(LONE_SURROGATE, "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  let capped = cleaned.slice(0, max);
  if (/[\ud800-\udbff]$/.test(capped)) capped = capped.slice(0, -1);
  return capped.trimEnd() || null;
}

const HOME_PARENTS: ReadonlySet<string> = new Set(["home", "users"]);

/** The local account name, or null if the OS won't say (userInfo throws for some uids). */
export function localUsername(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

/**
 * Only the last path segment of a working directory, never the full path.
 * Handles POSIX and Windows separators. Returns null for roots, bare drive
 * letters and home directories themselves (`/home/<user>`, `C:\Users\<user>`,
 * `/mnt/c/Users/<user>`, `/root`), whose last segment would be the account
 * name, and for any segment equal to `username` (case-insensitive), which
 * covers profiles elsewhere (e.g. `D:\Profiles\<user>`).
 */
export function projectLabelFromCwd(cwd: unknown, username: string | null = null): string | null {
  if (typeof cwd !== "string") return null;
  const segments = cwd.split(/[\\/]+/).filter((s) => s !== "");
  const last = segments.at(-1);
  if (last === undefined || /^[A-Za-z]:$/.test(last)) return null;
  const parent = segments.at(-2);
  const isHomeDir =
    (parent !== undefined && HOME_PARENTS.has(parent.toLowerCase())) || (segments.length === 1 && last === "root");
  if (isHomeDir) return null;
  const label = cleanText(last, MAX_PROJECT_LABEL);
  if (label !== null && username && label.toLowerCase() === username.toLowerCase()) return null;
  return label;
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

export interface ClaudeCodeProviderOptions {
  runCommand: CommandRunner;
  /** `claude --version`; checked before the first read, after any failure and every VERSION_RECHECK_MS. */
  runVersion: CommandRunner;
  /** Default "generated" (content-free). */
  titlePolicy?: ClaudeTitlePolicy;
  now?: () => Date;
  /** Receives content-free notes, e.g. how many entries were skipped. */
  log?: (line: string) => void;
}

/** Content-free result of one diagnostic read: counts and fixed texts only. */
export interface ClaudeCodeDiagnosis {
  ok: boolean;
  version: string | null;
  compatibility: VersionCompatibility | null;
  failure: { kind: ClaudeCommandFailure; category: ProviderFailureCategory; message: string } | null;
  sessions: number;
  skipped: number;
  byStatus: Partial<Record<SessionStatus, number>>;
  titlePolicy: ClaudeTitlePolicy;
}

interface ReadResult {
  sessions: ProviderSession[];
  skipped: number;
}

/** Any thrown value as a fixed-text ClaudeCommandError. */
function sanitise(e: unknown, step: "agents" | "version"): ClaudeCommandError {
  // Only fixed texts leave the provider; arbitrary error messages may embed
  // output, so the original error is deliberately not attached as `cause`.
  return e instanceof ClaudeCommandError ? e : new ClaudeCommandError("spawn_failed", step);
}

/** Turns a completed run into a failure, or null when it can be parsed. */
function runFailure(result: CommandResult, step: "agents" | "version"): ClaudeCommandError | null {
  // A signal mid-output leaves partial stdout: never parse it.
  if (result.interrupted) return new ClaudeCommandError("interrupted", step);
  if (result.exitCode === 0) return null;
  if (result.authRequired) return new ClaudeCommandError("auth_required", step);
  return new ClaudeCommandError("exit_nonzero", step, { exitCode: result.exitCode });
}

/**
 * Lists live Claude Code sessions. poll() rejects with a ClaudeCommandError
 * (fixed message, plus `kind` and `category` for diagnostics) on any failure,
 * so the connector's provider_error handling applies (provider_ok = false,
 * a source_unavailable alert) and no session is marked ended because of one
 * bad read. The next poll after a failure starts over, version check included.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude-code" as const;
  readonly isDemo = false;
  private readonly runCommand: CommandRunner;
  private readonly runVersion: CommandRunner;
  private readonly titlePolicy: ClaudeTitlePolicy;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private versionCheckedAt: number | null = null;
  private version: string | null = null;
  private compatibility: VersionCompatibility | null = null;
  private loggedNewerVersion: string | null = null;

  constructor(opts: ClaudeCodeProviderOptions) {
    this.runCommand = opts.runCommand;
    this.runVersion = opts.runVersion;
    this.titlePolicy = opts.titlePolicy ?? DEFAULT_CLAUDE_TITLE_POLICY;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  async poll(): Promise<ProviderSession[]> {
    const { sessions, skipped } = await this.read();
    if (skipped > 0) this.log(`claude-code: skipped ${skipped} malformed or duplicate session entr${skipped === 1 ? "y" : "ies"}.`);
    return sessions;
  }

  /** One read for the `doctor` command: never throws, never returns titles, ids or paths. */
  async diagnose(): Promise<ClaudeCodeDiagnosis> {
    const base = { titlePolicy: this.titlePolicy };
    try {
      const { sessions, skipped } = await this.read();
      const byStatus: Partial<Record<SessionStatus, number>> = {};
      for (const s of sessions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      return { ...base, ok: true, version: this.version, compatibility: this.compatibility, failure: null, sessions: sessions.length, skipped, byStatus };
    } catch (e) {
      const err = sanitise(e, "agents");
      return {
        ...base,
        ok: false,
        version: this.version,
        compatibility: this.compatibility,
        failure: { kind: err.kind, category: err.category, message: err.message },
        sessions: 0,
        skipped: 0,
        byStatus: {},
      };
    }
  }

  private async read(): Promise<ReadResult> {
    try {
      await this.checkVersionIfDue();
      let result: CommandResult;
      try {
        result = await this.runCommand();
      } catch (e) {
        throw sanitise(e, "agents");
      }
      const failure = runFailure(result, "agents");
      if (failure) throw failure;
      const parsed = parseClaudeAgentsOutput(result.stdout, this.now(), { titlePolicy: this.titlePolicy });
      if (!parsed.ok) throw new ClaudeCommandError(parsed.kind, "agents");
      return parsed;
    } catch (e) {
      // Recovery: after any failure the binary may have been reinstalled,
      // updated or signed in, so the next read checks everything again.
      this.versionCheckedAt = null;
      throw sanitise(e, "agents");
    }
  }

  private async checkVersionIfDue(): Promise<void> {
    const now = this.now().getTime();
    if (this.versionCheckedAt !== null && now - this.versionCheckedAt < VERSION_RECHECK_MS) return;
    this.version = null;
    this.compatibility = null;
    let result: CommandResult;
    try {
      result = await this.runVersion();
    } catch (e) {
      throw sanitise(e, "version");
    }
    const failure = runFailure(result, "version");
    if (failure) throw failure;
    try {
      const { version, compatibility } = requireCompatibleClaudeVersion(result.stdout);
      this.version = formatClaudeVersion(version);
      this.compatibility = compatibility;
    } catch (e) {
      throw sanitise(e, "version");
    }
    if (this.compatibility === "newer_than_observed" && this.loggedNewerVersion !== this.version) {
      this.loggedNewerVersion = this.version;
      this.log(`claude-code: Claude Code ${this.version} is newer than the last version verified live; output is still validated strictly.`);
    }
    this.versionCheckedAt = now;
  }
}

export interface CreateClaudeCodeProviderOptions extends ClaudeRunnerOptions {
  titlePolicy?: ClaudeTitlePolicy;
  log?: (line: string) => void;
}

/** The provider with both fixed-argv runners on the same executable. */
export function createClaudeCodeProvider(opts: CreateClaudeCodeProviderOptions = {}): ClaudeCodeProvider {
  const runner: ClaudeRunnerOptions = {
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBufferBytes !== undefined ? { maxBufferBytes: opts.maxBufferBytes } : {}),
  };
  return new ClaudeCodeProvider({
    runCommand: createClaudeAgentsRunner(runner),
    runVersion: createClaudeVersionRunner({ ...(opts.command !== undefined ? { command: opts.command } : {}) }),
    ...(opts.titlePolicy !== undefined ? { titlePolicy: opts.titlePolicy } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

/** Lines for the `doctor` command. Counts, versions and fixed texts only. */
export function formatClaudeCodeDiagnosis(d: ClaudeCodeDiagnosis): string[] {
  const lines = [
    `claude-code: version ${d.version ?? "not determined"}${d.compatibility ? ` (${d.compatibility.replaceAll("_", " ")})` : ""}`,
    `claude-code: session titles: ${d.titlePolicy === "generated" ? "generated labels (no CLI text)" : "CLI session names"}`,
  ];
  if (d.failure) {
    lines.push(`claude-code: FAILED [${d.failure.category}] ${d.failure.message}`);
    return lines;
  }
  const statuses = Object.entries(d.byStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${status}=${n}`)
    .join(" ");
  lines.push(`claude-code: OK ${d.sessions} session(s)${statuses ? ` ${statuses}` : ""}; skipped ${d.skipped} entr${d.skipped === 1 ? "y" : "ies"}`);
  return lines;
}
