import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import type { ProviderFailureCategory } from "../types.js";

/*
 * The execution boundary for the Claude Code provider. Everything that starts
 * a process lives here:
 * - spawn() with shell: false, an argv fixed by the callers below, and an
 *   absolute executable: a bare "claude" is resolved on PATH here, never by
 *   the OS (which on Windows searches the current directory first);
 * - a minimal environment (childEnv), never the connector's own;
 * - stdin closed, so an interactive prompt (e.g. a login) can't block a read;
 * - a hard deadline that settles the call even if the process ignores SIGTERM
 *   or a grandchild keeps the pipes open, then SIGTERM and, after a grace
 *   period, SIGKILL;
 * - a stdout byte cap;
 * - stderr read into a small bounded buffer, only to classify it, and never
 *   returned, logged or attached to an error.
 *
 * Errors are ClaudeCommandError with fixed texts, safe to log and to show.
 */

/** Upper bounds for the default runners; callers may only lower them. */
export const CLAUDE_AGENTS_TIMEOUT_MS = 10_000;
export const CLAUDE_AGENTS_MAX_BUFFER_BYTES = 1024 * 1024;
export const CLAUDE_VERSION_TIMEOUT_MS = 5_000;
export const CLAUDE_VERSION_MAX_BUFFER_BYTES = 4 * 1024;
/** Time between SIGTERM and SIGKILL once a deadline or the size cap is hit. */
export const KILL_GRACE_MS = 1_000;
/** How much stderr is kept, in memory only, to classify a failure. */
const STDERR_SCAN_BYTES = 4 * 1024;

export interface CommandResult {
  stdout: string;
  exitCode: number;
  /** The process ended on a signal Tavro didn't send (e.g. SIGTERM mid-output). Its stdout is partial. */
  interrupted?: boolean;
  /** A content-free reading of stderr on a failed run; raw stderr never leaves the runner. */
  authRequired?: boolean;
}

export type CommandRunner = () => Promise<CommandResult>;

export type ClaudeCommandFailure =
  // Discovery and execution
  | "not_found"
  | "not_executable"
  | "batch_shim"
  | "spawn_failed"
  | "timeout"
  | "output_too_large"
  | "interrupted"
  | "exit_nonzero"
  | "auth_required"
  // Version compatibility
  | "version_unrecognised"
  | "version_too_old"
  | "version_too_new"
  // Output
  | "empty_output"
  | "invalid_json"
  | "not_array"
  | "unrecognised_entries"
  | "unidentified_entries";

/** Which command failed; only changes the wording. */
export type ClaudeCommandStep = "agents" | "version";

const STEP_LABEL: Record<ClaudeCommandStep, string> = {
  agents: "claude agents --json",
  version: "claude --version",
};

/** Diagnostics group each failure falls into (see ProviderFailureCategory). */
export const FAILURE_CATEGORY: Record<ClaudeCommandFailure, ProviderFailureCategory> = {
  not_found: "cli_missing",
  not_executable: "cli_missing",
  batch_shim: "cli_missing",
  spawn_failed: "failed",
  timeout: "timeout",
  output_too_large: "invalid_output",
  interrupted: "interrupted",
  exit_nonzero: "failed",
  auth_required: "auth_required",
  version_unrecognised: "incompatible_version",
  version_too_old: "incompatible_version",
  version_too_new: "incompatible_version",
  empty_output: "invalid_output",
  invalid_json: "invalid_output",
  not_array: "invalid_output",
  unrecognised_entries: "invalid_output",
  unidentified_entries: "invalid_output",
};

export interface ClaudeCommandErrorDetail {
  /** An integer exit code; nothing else from the process is ever put in a message. */
  exitCode?: number;
  /** A version string rebuilt from parsed integers, never the raw `--version` output. */
  version?: string;
  /** The supported bound that was crossed, from our own constants. */
  bound?: string;
}

function failureMessage(kind: ClaudeCommandFailure, step: ClaudeCommandStep, d: ClaudeCommandErrorDetail): string {
  const cmd = STEP_LABEL[step];
  switch (kind) {
    case "not_found":
      return "claude CLI was not found (not installed, or not on PATH).";
    case "not_executable":
      return "claude CLI was found but could not be executed (permission denied).";
    case "batch_shim":
      return "claude CLI is a .cmd/.bat shim, which can't be run safely without a shell; configure the absolute path to claude.exe instead.";
    case "spawn_failed":
      return `${cmd} could not be started.`;
    case "timeout":
      return `${cmd} timed out.`;
    case "output_too_large":
      return `${cmd} output exceeded the size limit.`;
    case "interrupted":
      return `${cmd} was interrupted before it finished.`;
    case "exit_nonzero":
      return `${cmd} exited with code ${Number.isInteger(d.exitCode) ? String(d.exitCode) : "unknown"}.`;
    case "auth_required":
      return "Claude Code is not signed in on this machine; run `claude` in a terminal to sign in.";
    case "version_unrecognised":
      return "claude --version output was not recognised as Claude Code; the format is not guessed.";
    case "version_too_old":
      return `Claude Code ${d.version ?? "?"} is older than the minimum supported version ${d.bound ?? "?"}.`;
    case "version_too_new":
      return `Claude Code ${d.version ?? "?"} is newer than the supported range (below ${d.bound ?? "?"}).`;
    case "empty_output":
      return `${cmd} produced no output.`;
    case "invalid_json":
      return `${cmd} output was not valid JSON.`;
    case "not_array":
      return `${cmd} output was not a JSON array.`;
    case "unrecognised_entries":
      return `${cmd} listed sessions in an unrecognised format.`;
    case "unidentified_entries":
      return `${cmd} listed an entry without a usable session id; the read was discarded so no session is wrongly marked ended.`;
  }
}

/** A failure whose message is fixed text plus integers, safe to log. */
export class ClaudeCommandError extends Error {
  readonly category: ProviderFailureCategory;

  constructor(
    readonly kind: ClaudeCommandFailure,
    step: ClaudeCommandStep = "agents",
    detail: ClaudeCommandErrorDetail = {},
  ) {
    super(failureMessage(kind, step, detail));
    this.name = "ClaudeCommandError";
    this.category = FAILURE_CATEGORY[kind];
  }
}

/*
 * Matched against bounded stderr/stdout of a failed run, only to pick the
 * auth_required diagnostic. UNVERIFIED: the real wording has not been
 * observed yet (docs/INTEGRATIONS.md, live checklist). A miss only means the
 * failure is reported as a plain non-zero exit.
 */
const AUTH_HINT = /not (?:logged|signed) in|please (?:run )?\/?log ?in|\/login\b|invalid api key|unauthori[sz]ed|authentication (?:required|failed)|oauth token (?:has )?expired/i;

export interface BoundedRunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  step: ClaudeCommandStep;
  killGraceMs?: number;
  /** The child's complete environment. Default: childEnv(process.env). */
  env?: NodeJS.ProcessEnv;
}

export type SourceEnv = Readonly<Record<string, string | undefined>>;

/*
 * What the child may see of the connector's environment: enough to find the
 * user's profile, config and temp directories, nothing else. In particular no
 * MC_* (the connector's own settings), no NODE_OPTIONS (code injection into a
 * Node-based CLI), no proxies and no credentials. UNVERIFIED against the live
 * CLI (docs/INTEGRATIONS.md, live checklist).
 */
const CHILD_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
];

/** Looks up `name`, case-insensitively on Windows (where env names are). */
function envValue(env: SourceEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const want = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === want && v !== undefined) return v;
  return undefined;
}

/** The allow-listed subset of `source` (CHILD_ENV_KEYS); everything else is dropped. */
export function childEnv(source: SourceEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = envValue(source, key, platform);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type PathResolution = { kind: "found"; path: string } | { kind: "batch_shim" } | { kind: "not_found" };

export interface ResolveOnPathOptions {
  platform?: NodeJS.Platform;
  /** For tests: whether `path` is a file this process may execute. */
  isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Fully qualified: a drive path (`C:\…`) or UNC share on Windows, `/…` elsewhere. Not `\dir` (drive-relative). */
function isQualifiedDir(dir: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(dir) : posix.isAbsolute(dir);
}

/**
 * Resolves a bare executable name on PATH to an absolute path. Empty, "." and
 * relative entries are skipped: they'd resolve against whatever directory the
 * connector was started in. On Windows only PATHEXT's .exe and .com are
 * candidates; a .cmd/.bat found instead (npm's global install creates
 * claude.cmd) is reported as batch_shim, because running one needs a shell.
 */
export function resolveOnPath(name: string, env: SourceEnv, opts: ResolveOnPathOptions = {}): PathResolution {
  const platform = opts.platform ?? process.platform;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const path = platform === "win32" ? win32 : posix;
  const entries = (envValue(env, "PATH", platform) ?? "").split(path.delimiter);
  let exts = [""];
  let shimExts: string[] = [];
  if (platform === "win32") {
    const listed = (envValue(env, "PATHEXT", platform) ?? ".COM;.EXE").split(";").map((e) => e.trim().toLowerCase());
    exts = listed.filter((e) => e === ".exe" || e === ".com");
    if (exts.length === 0) exts = [".exe", ".com"];
    shimExts = [".cmd", ".bat"];
  }
  let sawShim = false;
  for (const raw of entries) {
    // Windows PATH entries may be quoted.
    const dir = platform === "win32" ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    if (dir === "" || dir === "." || !isQualifiedDir(dir, platform)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return { kind: "found", path: candidate };
    }
    if (!sawShim) sawShim = shimExts.some((ext) => isExecutable(path.join(dir, name + ext)));
  }
  return sawShim ? { kind: "batch_shim" } : { kind: "not_found" };
}

function spawnFailure(error: unknown): ClaudeCommandFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "not_executable";
  // Node refuses .cmd/.bat without a shell (CVE-2024-27980) with EINVAL.
  if (code === "EINVAL" && process.platform === "win32") return "batch_shim";
  return "spawn_failed";
}

/**
 * Runs `command` with `args` under the limits above. Exported for tests; the
 * provider only reaches it through the two fixed-argv runners below.
 * Resolves for any completed run (including non-zero exits and signals);
 * rejects with ClaudeCommandError for spawn failures, the deadline and the cap.
 */
export function runBounded(command: string, args: readonly string[], opts: BoundedRunOptions): Promise<CommandResult> {
  const grace = opts.killGraceMs ?? KILL_GRACE_MS;
  return new Promise<CommandResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? childEnv(process.env) });
    } catch (e) {
      reject(new ClaudeCommandError(spawnFailure(e), opts.step));
      return;
    }

    let settled = false;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    // Settle first, then make sure the process actually goes away.
    const abort = (kind: ClaudeCommandFailure) => {
      settle(() => reject(new ClaudeCommandError(kind, opts.step)));
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, grace);
        escalate.unref();
      }
    };
    const deadline = setTimeout(() => abort("timeout"), opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxStdoutBytes) return abort("output_too_large");
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_SCAN_BYTES) return;
      const part = chunk.subarray(0, STDERR_SCAN_BYTES - stderrBytes);
      stderrBytes += part.length;
      stderr += part.toString("utf8");
    });
    child.on("error", (e) => settle(() => reject(new ClaudeCommandError(spawnFailure(e), opts.step))));
    child.on("close", (code, signal) => {
      settle(() => {
        const text = Buffer.concat(stdout).toString("utf8");
        if (signal !== null || code === null) return resolve({ stdout: text, exitCode: -1, interrupted: true });
        const authRequired = code !== 0 && AUTH_HINT.test(`${stderr}\n${text.slice(0, STDERR_SCAN_BYTES)}`);
        resolve({ stdout: text, exitCode: code, ...(authRequired ? { authRequired } : {}) });
      });
    });
  });
}

export interface ClaudeRunnerOptions {
  /** Executable: the bare name "claude" (resolved on PATH) or an absolute path. Default "claude". */
  command?: string;
  /** Capped at the step's default. */
  timeoutMs?: number;
  /** Capped at the step's default. */
  maxBufferBytes?: number;
  /** For tests only. */
  killGraceMs?: number;
  /** For tests only: the environment PATH is read from and the child's is built from. Default process.env. */
  env?: SourceEnv;
}

/**
 * Validates the executable. A relative path would resolve against whatever
 * directory the connector was started in, so only "claude" or an absolute
 * path is accepted. Throws a fixed-text TypeError (a configuration error).
 */
export function validateClaudeCommand(command: string): string {
  if (command === "claude") return command;
  if (command.includes("\0") || !isAbsolute(command)) {
    throw new TypeError('The claude executable must be "claude" (found on PATH) or an absolute path.');
  }
  return command;
}

function isBatchShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

function createRunner(step: ClaudeCommandStep, args: readonly string[], maxTimeout: number, maxBytes: number, opts: ClaudeRunnerOptions): CommandRunner {
  const command = validateClaudeCommand(opts.command ?? "claude");
  const timeoutMs = Math.min(opts.timeoutMs ?? maxTimeout, maxTimeout);
  const maxStdoutBytes = Math.min(opts.maxBufferBytes ?? maxBytes, maxBytes);
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  return () => {
    const source = opts.env ?? process.env;
    let executable = command;
    // Resolved on every run, so a CLI installed after the connector started is found.
    if (command === "claude") {
      const found = resolveOnPath(command, source);
      if (found.kind !== "found") return Promise.reject(new ClaudeCommandError(found.kind, step));
      executable = found.path;
    }
    // Refuse before spawning: running one would need a shell.
    if (isBatchShim(executable)) return Promise.reject(new ClaudeCommandError("batch_shim", step));
    return runBounded(executable, args, { timeoutMs, maxStdoutBytes, step, killGraceMs, env: childEnv(source) });
  };
}

/** `claude agents --json`: fixed argv, no shell, at most 10 s and 1 MB. */
export function createClaudeAgentsRunner(opts: ClaudeRunnerOptions = {}): CommandRunner {
  return createRunner("agents", ["agents", "--json"], CLAUDE_AGENTS_TIMEOUT_MS, CLAUDE_AGENTS_MAX_BUFFER_BYTES, opts);
}

/** `claude --version`: fixed argv, no shell, at most 5 s and 4 KB. */
export function createClaudeVersionRunner(opts: ClaudeRunnerOptions = {}): CommandRunner {
  return createRunner("version", ["--version"], CLAUDE_VERSION_TIMEOUT_MS, CLAUDE_VERSION_MAX_BUFFER_BYTES, opts);
}
