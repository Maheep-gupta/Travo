import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ClaudeCommandError,
  childEnv,
  createClaudeAgentsRunner,
  createClaudeVersionRunner,
  resolveOnPath,
  runBounded,
  validateClaudeCommand,
  type BoundedRunOptions,
  type CommandResult,
} from "../src/providers/claude-code-process.js";
import { createClaudeCodeProvider } from "../src/providers/claude-code.js";

/*
 * The execution boundary, exercised with SYNTHETIC child processes: the Node
 * binary running inline scripts. `claude` is never spawned, and nothing here
 * says how the real CLI behaves.
 */

const NODE = process.execPath;
const OPTS: BoundedRunOptions = { timeoutMs: 5_000, maxStdoutBytes: 64 * 1024, step: "agents", killGraceMs: 200 };

function node(script: string, opts: Partial<BoundedRunOptions> = {}, extra: string[] = []): Promise<CommandResult> {
  return runBounded(NODE, ["-e", script, ...extra], { ...OPTS, ...opts });
}

async function rejection(p: Promise<unknown>): Promise<ClaudeCommandError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ClaudeCommandError);
  return err as ClaudeCommandError;
}

describe("runBounded", { timeout: 15_000 }, () => {
  it("returns stdout and exit code 0", async () => {
    expect(await node("process.stdout.write('[]')")).toEqual({ stdout: "[]", exitCode: 0 });
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const r = await node("const b=Buffer.from('\\u00e9\\u{1F600}');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)");
    expect(r.stdout).toBe("é\u{1F600}");
  });

  it("uses no shell: metacharacters in arguments reach the process verbatim", async () => {
    const args = ["a;echo SYNTHETIC", "$(whoami)", "%PATH%", "`id`", "x | y", "&&"];
    const r = await node("process.stdout.write(JSON.stringify(process.argv.slice(1)))", {}, args);
    expect(JSON.parse(r.stdout)).toEqual(args);
  });

  it("closes stdin, so a prompt for input can't block the read", async () => {
    const r = await node("process.stdin.on('end',()=>process.stdout.write('eof'));process.stdin.resume()", { timeoutMs: 3_000 });
    expect(r).toEqual({ stdout: "eof", exitCode: 0 });
  });

  it("resolves a non-zero exit and never returns stderr", async () => {
    const r = await node("process.stdout.write('partial');process.stderr.write('SYNTHETIC-SECRET-MARKER /home/dev/projects/alpha');process.exit(3)");
    expect(r).toEqual({ stdout: "partial", exitCode: 3 });
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC-SECRET-MARKER");
  });

  // The wording below is SYNTHETIC: the real CLI's sign-in message is unverified.
  it.each([["Invalid API key · Please run /login"], ["Error: not logged in"], ["OAuth token has expired"]])("flags %j on stderr as auth_required", async (msg) => {
    const r = await node(`process.stderr.write(${JSON.stringify(msg)});process.exit(1)`);
    expect(r).toEqual({ stdout: "", exitCode: 1, authRequired: true });
  });

  it("does not flag auth on a successful run", async () => {
    expect(await node("process.stderr.write('please run /login');process.stdout.write('[]')")).toEqual({ stdout: "[]", exitCode: 0 });
  });

  it("rejects with output_too_large once stdout passes the cap, and stops the process", async () => {
    const start = Date.now();
    const err = await rejection(node("const s='x'.repeat(4096);setInterval(()=>process.stdout.write(s),1)", { maxStdoutBytes: 1024 }));
    expect(err.kind).toBe("output_too_large");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("rejects with timeout at the deadline", async () => {
    const start = Date.now();
    const err = await rejection(node("setInterval(()=>{},1000)", { timeoutMs: 300 }));
    expect(err).toMatchObject({ kind: "timeout", category: "timeout", message: "claude agents --json timed out." });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("settles at the deadline even when the process ignores SIGTERM", async () => {
    const start = Date.now();
    const err = await rejection(node("process.on('SIGTERM',()=>{});process.stdout.write('[');setInterval(()=>{},1000)", { timeoutMs: 300 }));
    expect(err.kind).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("kills the process after the deadline (SIGKILL after the grace period if SIGTERM is ignored)", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "tavro-runner-")), "pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    // The deadline leaves room for a slow Node start under a loaded test run.
    await rejection(node(script, { timeoutMs: 3_000 }));
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = Date.now() + 3_000;
    while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it("marks a run killed by a signal mid-output as interrupted (or a failed exit on Windows)", async () => {
    const r = await node("process.stdout.write('[{\"sessionId\":');process.kill(process.pid,'SIGTERM')");
    // POSIX reports the signal; Windows terminates the process with an exit code instead.
    if (process.platform === "win32") expect(r.interrupted === true || r.exitCode !== 0).toBe(true);
    else expect(r).toMatchObject({ interrupted: true, exitCode: -1 });
  });

  it("rejects with not_found for a missing executable (ENOENT)", async () => {
    expect((await rejection(runBounded("tavro-synthetic-no-such-binary", [], OPTS))).kind).toBe("not_found");
    const err = await rejection(runBounded(join(tmpdir(), "tavro-synthetic-missing", "claude"), [], OPTS));
    expect(err).toMatchObject({ kind: "not_found", category: "cli_missing" });
    expect(err.message).not.toContain(tmpdir());
  });
});

describe("claude runners", () => {
  it("accept only \"claude\" or an absolute path", () => {
    expect(validateClaudeCommand("claude")).toBe("claude");
    expect(validateClaudeCommand(NODE)).toBe(NODE);
    for (const bad of ["./claude", "bin/claude", "claude.exe", "", `${NODE}\0x`]) {
      expect(() => validateClaudeCommand(bad)).toThrow(TypeError);
      expect(() => createClaudeAgentsRunner({ command: bad })).toThrow(TypeError);
    }
  });

  it("refuse a .cmd/.bat shim before spawning anything", async () => {
    for (const shim of ["claude.cmd", "CLAUDE.BAT"]) {
      // The file doesn't exist: a spawn attempt would report not_found instead.
      const err = await rejection(createClaudeAgentsRunner({ command: join(tmpdir(), "tavro-synthetic", shim) })());
      expect(err).toMatchObject({ kind: "batch_shim", category: "cli_missing" });
    }
  });

  it("run a fixed argv: a wrong binary is caught by the version gate", async () => {
    // Node standing in for "some other program called claude": `node --version` prints vX.Y.Z.
    const version = await createClaudeVersionRunner({ command: NODE })();
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^v\d+\./);
    const err = await rejection(createClaudeCodeProvider({ command: NODE }).poll());
    expect(err).toMatchObject({ kind: "version_unrecognised", category: "incompatible_version" });
  });

  it("never surface the stderr of a failing wrong binary", async () => {
    // `node agents --json` fails with a module-not-found error naming a full path on stderr.
    const r = await createClaudeAgentsRunner({ command: NODE })();
    expect(r.exitCode).not.toBe(0);
    expect(JSON.stringify(r)).not.toMatch(/agents['"]|Cannot find module|[\\/]/);
  });
});

describe("resolveOnPath", () => {
  // Pure checks: isExecutable stands in for the filesystem and records every probe.
  function probe(files: string[]) {
    const probed: string[] = [];
    const set = new Set(files.map((f) => f.toLowerCase()));
    const isExecutable = (p: string): boolean => {
      probed.push(p);
      return set.has(p.toLowerCase());
    };
    return { probed, isExecutable };
  }

  it("skips empty, '.' and relative entries on Windows, and never probes them", () => {
    const fs = probe(["C:\\tools\\claude.exe", "bin\\claude.exe", ".\\claude.exe"]);
    const r = resolveOnPath("claude", { Path: ';.;bin;\\drive-relative;"C:\\tools"', PATHEXT: ".COM;.EXE;.BAT;.CMD" }, { platform: "win32", isExecutable: fs.isExecutable });
    expect(r).toEqual({ kind: "found", path: "C:\\tools\\claude.exe" });
    expect(fs.probed.every((p) => /^C:\\tools\\/.test(p))).toBe(true);
  });

  it("tries only .exe and .com from PATHEXT, in PATHEXT order", () => {
    const fs = probe(["C:\\a\\claude.exe", "C:\\a\\claude.com"]);
    expect(resolveOnPath("claude", { PATH: "C:\\a", PATHEXT: ".EXE;.COM" }, { platform: "win32", isExecutable: fs.isExecutable })).toEqual({ kind: "found", path: "C:\\a\\claude.exe" });
    expect(resolveOnPath("claude", { PATH: "C:\\a", PATHEXT: ".COM;.EXE" }, { platform: "win32", isExecutable: fs.isExecutable })).toEqual({ kind: "found", path: "C:\\a\\claude.com" });
    // A bare "claude" file (no extension) is never a candidate on Windows.
    const bare = probe(["C:\\a\\claude"]);
    expect(resolveOnPath("claude", { PATH: "C:\\a" }, { platform: "win32", isExecutable: bare.isExecutable })).toEqual({ kind: "not_found" });
  });

  it("reports an npm .cmd/.bat shim as batch_shim, never runs it, and prefers a real .exe later on PATH", () => {
    const shimOnly = probe(["C:\\npm\\claude.cmd"]);
    expect(resolveOnPath("claude", { PATH: "C:\\npm;C:\\other" }, { platform: "win32", isExecutable: shimOnly.isExecutable })).toEqual({ kind: "batch_shim" });
    const both = probe(["C:\\npm\\claude.cmd", "C:\\native\\claude.exe"]);
    expect(resolveOnPath("claude", { PATH: "C:\\npm;C:\\native" }, { platform: "win32", isExecutable: both.isExecutable })).toEqual({ kind: "found", path: "C:\\native\\claude.exe" });
  });

  it("on POSIX skips empty, '.' and relative entries", () => {
    const fs = probe(["/usr/local/bin/claude", "bin/claude", "./claude"]);
    expect(resolveOnPath("claude", { PATH: ":.:bin:/usr/local/bin" }, { platform: "linux", isExecutable: fs.isExecutable })).toEqual({ kind: "found", path: "/usr/local/bin/claude" });
    expect(fs.probed).toEqual(["/usr/local/bin/claude"]);
    expect(resolveOnPath("claude", { PATH: ".:bin:" }, { platform: "linux", isExecutable: fs.isExecutable })).toEqual({ kind: "not_found" });
  });

  it("is not_found without a PATH", () => {
    expect(resolveOnPath("claude", {}, { platform: "win32", isExecutable: () => true })).toEqual({ kind: "not_found" });
  });
});

describe("childEnv", () => {
  it("passes only the allow-listed variables: no MC_*, NODE_OPTIONS, proxies or keys", () => {
    const env = childEnv(
      {
        PATH: "/bin",
        HOME: "/home/dev",
        TMPDIR: "/tmp",
        MC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
        MC_DATA_DIR: ".data",
        NODE_OPTIONS: "--require /tmp/evil.js",
        HTTPS_PROXY: "http://user:pass@proxy",
        ANTHROPIC_API_KEY: "SYNTHETIC-SECRET-MARKER",
        SUPABASE_SECRET_KEYS: "SYNTHETIC-SECRET-MARKER",
      },
      "linux",
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/dev", TMPDIR: "/tmp" });
  });

  it("matches names case-insensitively on Windows", () => {
    expect(childEnv({ Path: "C:\\bin", SYSTEMROOT: "C:\\Windows", userprofile: "C:\\Users\\dev", mc_provider: "mock" }, "win32")).toEqual({
      PATH: "C:\\bin",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\dev",
    });
  });
});

describe("claude runners resolve a bare claude on PATH", { timeout: 30_000 }, () => {
  // A temp directory with Node standing in as "claude" (claude.exe on Windows). Never the real CLI.
  function fakeClaudeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tavro-path-"));
    const target = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      linkSync(NODE, target);
    } catch {
      copyFileSync(NODE, target);
    }
    if (process.platform !== "win32") chmodSync(target, 0o755);
    return dir;
  }

  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("spawns the absolute result with a minimal environment", async () => {
    const dir = fakeClaudeDir();
    dirs.push(dir);
    const sep = process.platform === "win32" ? ";" : ":";
    const env = { ...process.env, PATH: `.${sep}${sep}relative${sep}${dir}`, MC_SYNTHETIC: "SYNTHETIC-SECRET-MARKER" };
    const version = await createClaudeVersionRunner({ env })();
    expect(version).toMatchObject({ exitCode: 0 });
    expect(version.stdout).toMatch(/^v\d+\./);
    // `node agents --json` fails (stderr never returned), but it shows the resolved binary was spawned.
    const agents = await createClaudeAgentsRunner({ env })();
    expect(agents.exitCode).not.toBe(0);
  });

  it("gives the child no MC_* variables", async () => {
    const r = await runBounded(NODE, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
      ...OPTS,
      env: childEnv({ ...process.env, MC_SYNTHETIC: "SYNTHETIC-SECRET-MARKER", MC_DATA_DIR: ".data" }),
    });
    const keys = JSON.parse(r.stdout) as string[];
    expect(keys.some((k) => k.toUpperCase().startsWith("MC_"))).toBe(false);
    expect(keys.some((k) => k.toUpperCase() === "PATH")).toBe(true);
  });

  it("fails as cli_missing when claude isn't on PATH, and as batch_shim for a .cmd shim", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tavro-path-empty-"));
    dirs.push(empty);
    const missing = await rejection(createClaudeVersionRunner({ env: { PATH: empty } })());
    expect(missing).toMatchObject({ kind: "not_found", category: "cli_missing" });
    if (process.platform === "win32") {
      const shimDir = mkdtempSync(join(tmpdir(), "tavro-path-shim-"));
      dirs.push(shimDir);
      writeFileSync(join(shimDir, "claude.cmd"), "@echo SYNTHETIC\r\n");
      const shim = await rejection(createClaudeAgentsRunner({ env: { PATH: shimDir } })());
      expect(shim).toMatchObject({ kind: "batch_shim", category: "cli_missing" });
      expect(shim.message).toMatch(/absolute path to claude\.exe/);
      expect(shim.message).not.toContain(shimDir);
    }
  });
});
