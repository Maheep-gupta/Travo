# Integration capability matrix

The source of truth is `PROVIDERS` in `packages/domain/src/capabilities.ts`. The UI renders capabilities from that table; it never infers them from what buttons exist.

Legend:
- ✅ implemented and tested
- 🧪 implemented, but untested against a live system
- ⛔ disabled by policy or decision
- ❌ no supported mechanism

| Capability | Demo (mock) | Claude Code (local) | Claude Desktop | Cowork | claude.ai (browser) |
|---|---|---|---|---|---|
| Discover sessions | ✅ | ⛔ adapter disabled until RLS tests pass. Planned mechanism: `claude agents --json` (verified on this laptop) | ❌ | ❌ | ❌ |
| Session details / status | ✅ | ⛔ (same) | ❌ | ❌ | ❌ |
| Read recent messages | ✅ (simulated) | ⛔. Planned: Agent SDK `getSessionMessages`, loopback DB only | ❌ | ❌ | ❌ |
| Live status events | ✅ | ⛔. Planned: polling; hooks are optional and need approval to edit `~/.claude/settings.json` | ❌ | ❌ | ❌ |
| Send message to an existing live session | ❌ | ❌ No supported API. Remote Control is the only route, and it's disabled by org policy (`allow_remote_control: false`). | ❌ | ❌ | ❌ |
| Resume a finished session (`claude -p --resume`) | ❌ | ⛔ Disabled by user decision | ❌ | ❌ | ❌ |
| Approve permission prompts | ❌ | ⛔ Disabled (a `PermissionRequest` hook could do it; not approved) | ❌ | ❌ | ❌ |
| Continue elsewhere | n/a | Terminal or VS Code window | Open Desktop | Open Desktop | Open claude.ai |

## Claude Code adapter (disabled)

**Status: Implemented, and Automated-test verified against SYNTHETIC output only.** Nothing below has run against a live `claude` CLI. The adapter stays off (`REAL_ADAPTER_ENABLED = false` in `apps/connector/src/config.ts`) until three things have happened: `npm run test:db` passes, the founder approves enabling it, and the checklist at the end of this section has been run and recorded.

Code:
- `apps/connector/src/providers/claude-code.ts`: parsing, the provider, the title policy and diagnostics.
- `claude-code-process.ts`: the execution boundary.
- `claude-code-version.ts`: the version gate.

Fixtures are in `apps/connector/test/fixtures/claude-agents/`. They are synthetic; see the README there.

The adapter only reads. It sends nothing to Claude Code: no replies, approvals, resumes or commands (org policy `allow_remote_control: false`).

### Lifecycle mapping

| Source | Our status | Notes |
|---|---|---|
| `claude agents --json` `status: "busy"` | `running` | Shape recorded once on this laptop (CLI 2.1.312). `last_activity_at` is the time of the read. |
| `status: "idle"` | `waiting_for_input` | Idle at the prompt: the turn is finished or it's waiting for you. **Not** `completed`. |
| Any other value, including `"BUSY"`, `" busy"`, numbers or `null` | `unknown`, with the fixed reason "Unrecognised status from the provider." The raw value is never quoted, because `status_reason` syncs to the cloud. | Never guessed: no case-folding or trimming. |
| Session no longer listed after a **successful** read | `ended` (`status_source: "derived"`, event "Session closed") | Never `completed` (spec 4.1). The connector does this, not the provider. |
| Read failed (any failure below) | Unchanged. The host reports `provider_ok = false` with the failure category (schema v4). | The dashboard shows "Source not responding" and raises `source_unavailable` (D-014); the host page names the cause and what to do (D-026). Nothing is marked ended. |
| `Notification` hook with `permission_prompt` | `approval_required` | Not implemented. Needs approval to edit `~/.claude/settings.json`. |
| `StopFailure` hook | `failed` | Not implemented. Needs hooks. |

This adapter never produces `completed`. The CLI list gives no evidence that a task finished successfully, only that a process is idle or gone.

### Session identity and host

- **Id:** `external_id` is the entry's `sessionId`, verbatim. It must be 1–200 printable ASCII characters with no spaces. It is never trimmed or truncated, because either could merge two sessions. An entry without a usable id (missing, wrongly typed, not an object) fails the **whole read** as `unidentified_entries`: it could be a session already known, and leaving it out would mark that session ended (missing data isn't negative evidence, spec 4.1/4.2). `pid` is ignored, because it changes when a session is resumed.
- **Stable across reads:** the same `sessionId` gives the same session row and no duplicate "discovered" event. That holds across polls and across connector restarts, because the connector reloads known sessions from the backend. Tested with synthetic output through the real `Connector`.
- **Duplicates:** if one read lists the same id twice, the first entry wins and the rest are counted as skipped.
- **Host:** the provider doesn't associate sessions with a host. Rows are written with the paired host's credentials, and the database sets `host_id` and `owner_id` (`docs/SECURITY.md`). One connector process per host is assumed. Overlapping processes are handled by the schema v3 stale-write guard.
- **Disappearance:** a session missing from one successful read is `ended` straight away. If it appears again, it gets a `status_changed` event back to its live status. There is no grace period, because keeping a vanished session "running" would show outdated data as live. Whether the CLI ever drops a live session from a single read is a checklist item.

### Session titles (D-004, D-013)

Claude Code may name a session from its first prompt, so the CLI's `name` can carry prompt text off the machine. The provider therefore has a title policy, `ClaudeCodeProviderOptions.titlePolicy`:

| Policy | Title sent | Default |
|---|---|---|
| `generated` | `Session <last 8 characters of sessionId>`. Content-free. It uses the end of the id because the start of a time-ordered id is a timestamp. | **Yes** |
| `cli_name` | The CLI's `name`, cleaned and capped at 300 characters | No |

Offer `cli_name` only as an explicit opt-in, and only after two things: the live check shows whether names are prompt-derived, and the founder approves, because it relaxes a privacy default (D-017).

There is no environment variable for the policy yet, because `config.ts` isn't part of this change. Proposed: `MC_CLAUDE_SESSION_TITLES=generated|cli_name`, default `generated`.

**Text cleaning, under either policy:**
- These characters are replaced with a space: C0 and C1 controls, DEL, zero-width characters, bidi embedding, override and isolate characters, line and paragraph separators, and characters that render as nothing or can hide text: U+034F, the Hangul fillers U+115F, U+1160 and U+3164, U+17B4/U+17B5, variation selectors (U+FE00–FE0F, U+E0100–E01EF), interlinear annotation marks (U+FFF9–FFFB) and tag characters (U+E0000–E007F).
- Lone surrogates are dropped.
- Whitespace is collapsed.
- Length is capped without splitting a surrogate pair. A lone surrogate would make Postgres reject the whole upsert as invalid JSON.

**Project label:** only the last folder of `cwd`. It is dropped for roots and home folders (`/home/<user>`, `C:\Users\<user>`, `/mnt/c/Users/<user>`, `/root`), because that segment would be the account name. It is also dropped when it equals the local account name (`os.userInfo().username`, case-insensitive), which covers profiles elsewhere, such as `D:\Profiles\<user>`. If the OS won't give a username, only the path rules apply.

### Execution boundary

- **No shell, fixed arguments:** `spawn` with `shell: false` and a fixed argv, `["--version"]` or `["agents", "--json"]`. Tests show that shell metacharacters reach the process verbatim.
- **Which executable:**
  - It must be the bare name `claude` or an absolute path. Relative paths are refused, because they would resolve against wherever the connector was started.
  - A bare `claude` is resolved on PATH by the adapter itself (`resolveOnPath`), and the absolute result is spawned. The OS isn't asked, because on Windows libuv searches the current directory before PATH. Empty, `.` and relative PATH entries are skipped. On Windows only PATHEXT's `.exe` and `.com` are candidates. Not found is `not_found` (`cli_missing`).
  - `.cmd` and `.bat` shims are refused before spawning. Running one needs a shell (Node rejects them since CVE-2024-27980), and this adapter never uses `shell: true`. If PATH has only a `claude.cmd`/`.bat` (an npm global install), the read fails as `batch_shim` (`cli_missing`) with "configure the absolute path to claude.exe", not as "not installed".
- **Environment:** the child gets an allow-list (`childEnv`): `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `SystemDrive`, `windir`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `LC_ALL`, the `XDG_*` base directories and `CLAUDE_CONFIG_DIR`. No `MC_*`, no `NODE_OPTIONS`, no proxy variables and no API keys. *Unverified live:* that `claude agents --json` needs nothing else (e.g. a proxy, or `ANTHROPIC_API_KEY` for API-key sign-in). A missing variable would show as a failed read, never as wrong data. This is a checklist item.
- **stdin** is closed, so a login or other prompt can't block a read.
- **Deadline:** 10 s for `agents --json` and 5 s for `--version`; callers can only lower them.
  - At the deadline the call fails at once, even if the process ignores SIGTERM or a grandchild holds the pipes.
  - The process then gets SIGTERM, and SIGKILL 1 s later if it is still running.
- **stdout cap:** 1 MB for `agents` and 4 KB for `--version`. Crossing it fails the read and kills the process.
- **stderr:** at most 4 KB is kept in memory, only to recognise a sign-in failure. It is never returned, logged or attached to an error.
- **Error text:** fixed messages plus integers only: an exit code, or a version rebuilt from the parsed numbers.
- **Interrupted runs:** a run that ends on a signal Tavro didn't send (for example SIGTERM mid-output) is `interrupted`. Its partial stdout is never parsed.

### Version compatibility

**UNVERIFIED until the live checklist has run.** The only recorded observation is CLI 2.1.312.

- `claude --version` must print exactly `<major>.<minor>.<patch> (Claude Code)`. A leading BOM and surrounding whitespace are allowed.
- Anything else is `version_unrecognised`: another program called `claude`, a different format, an extra line. The provider then reports the source as unavailable instead of guessing.
- Supported range: **≥ 2.1.312 and < 3.0.0** (`MIN_SUPPORTED_CLAUDE_VERSION`, `MAX_SUPPORTED_CLAUDE_VERSION_EXCLUSIVE`).
- Versions inside the range but newer than the last one verified live (`LAST_OBSERVED_CLAUDE_VERSION`) still work. This is logged once, and the output is still validated strictly.
- The version is checked before the first read, after any failure, and every 10 minutes, because auto-updates replace the binary.

### Failure diagnostics

To the backend, every failure means `provider_ok = false`, and since schema v4 (D-026) the heartbeat also sends the failure's **category** as `provider_error_kind` (never the message). The connector heartbeats at once when the category changes, so the host page always shows the current cause with what to do (`sourceFailureText` in `packages/domain`). The connector logs the fixed message once per outage (`provider error: claude-code: …`) and `provider recovered` on the next good read. The error also carries `kind` for the `doctor` command and logs; `kind` never leaves the machine. Session writes the backend keeps skipping or refusing are reported as the connector's own category, `writes_not_applied` (D-015).

| Category | Kinds | Example message (fixed text) |
|---|---|---|
| `cli_missing` | `not_found` (ENOENT), `not_executable` (EACCES/EPERM), `batch_shim` | "claude CLI was not found (not installed, or not on PATH)." |
| `auth_required` | `auth_required` | "Claude Code is not signed in on this machine; …" |
| `timeout` | `timeout` | "claude agents --json timed out." |
| `invalid_output` | `empty_output`, `invalid_json` (includes truncated JSON), `not_array`, `unrecognised_entries`, `unidentified_entries`, `output_too_large` | "… was not valid JSON." |
| `incompatible_version` | `version_unrecognised`, `version_too_old`, `version_too_new` | "Claude Code 3.0.1 is newer than the supported range (below 3.0.0)." |
| `interrupted` | `interrupted` | "… was interrupted before it finished." |
| `failed` | `exit_nonzero`, `spawn_failed` | "… exited with code 2." / "… could not be started." |

- `auth_required` is recognised from the bounded stderr or stdout of a failed run. **The real wording is unverified.** If it isn't recognised, the failure shows as a non-zero exit.
- `unrecognised_entries` means a non-empty list in which no entry has a valid `sessionId`, which suggests the format changed. `unidentified_entries` means at least one entry, but not all, lacks one.

**Recovery:** the provider keeps no state between reads apart from the version check, and it redoes that check after any failure. The connector's existing backoff and recovery logic applies unchanged, and is tested for each category above.

**`npm run connector -- doctor`** makes one read and prints the version and compatibility, the title policy, and then one of these:
- `OK <n> session(s) running=… waiting_for_input=…; skipped <k>`
- `FAILED [<category>] <message>`

It never prints titles, ids or paths, and exits with code 1 on failure. It refuses to run while `REAL_ADAPTER_ENABLED` is false.

### Not wired yet (needs changes outside the provider)

- `cli.ts` `run` always constructs `MockProvider`. Enabling the adapter needs `config.MC_PROVIDER === "claude-code" ? createClaudeCodeProvider({ log }) : new MockProvider()`.
- There is no config for the executable path or the title policy yet. Proposed: `MC_CLAUDE_PATH` (absolute, validated by `validateClaudeCommand`) and `MC_CLAUDE_SESSION_TITLES`.
- The connector keeps only the error message, not `kind` or `category`. Proposed: keep `category` on `ProviderError`, so a diagnostics surface can show it without matching strings.

### Before enabling: live verification checklist

**Who and when:** an approved human, on an approved machine, **after** `npm run test:db` passes and **before** `REAL_ADAPTER_ENABLED` is flipped.

**Handling real output:** it contains real session names and paths.
- Save it **outside the repository**, for example in `$HOME/tavro-live-check/`.
- Never paste it into an issue, commit or chat.
- Delete it when done.
- Record only the results in this file: yes/no answers, versions, key names, status values and timings.

Commands are given for bash (macOS, Linux and Git Bash) and PowerShell.

1. **Which binary.** Run `command -v claude` (bash) or `Get-Command claude -All | Format-List Source` (PowerShell).
   - *Expect* one native executable.
   - *Compare:* on Windows, a `.cmd` or `.ps1` from an npm install is refused by the adapter. Record the path of a native `claude.exe` if there is one. Never work around a missing native binary with a shell.
2. **Version format.** Run `claude --version`.
   - *Expect* exactly `X.Y.Z (Claude Code)` on one line.
   - *Compare* with `parseClaudeVersion`. If the format differs, stop and update the parser and its tests before going further.
   - Record the version as `LAST_OBSERVED_CLAUDE_VERSION`. If it is below 2.1.312, justify the minimum by repeating steps 3–8 on that version.
3. **No sessions open.** Close all Claude Code sessions, then run `claude agents --json; echo "exit=$?"` (bash) or `claude agents --json; "exit=$LASTEXITCODE"` (PowerShell).
   - *Expect* `[]` and `exit=0`.
   - *Compare:* if it prints nothing, or anything other than a JSON array, change the empty-output rule (`empty_output` = failure) before enabling. Otherwise every poll with no sessions will look like a source failure.
4. **Shape.** Open two sessions in two different project folders. Leave one idle at its prompt, and give the other a long task so it stays busy. Then run `claude agents --json > "$HOME/tavro-live-check/agents.json"`.
   - *Expect* an array of objects with `sessionId`, `status`, `name`, `cwd` and `pid`.
   - *Compare* the exact key names and the status values (`busy`, `idle`).
   - Check whether any timestamp key exists. The adapter reads only `lastActivityAt` or `updatedAt`, and only if present.
   - Check whether `sessionId` is a UUID.
5. **Permission prompt.** In one session, trigger a tool permission prompt and leave it open, then repeat step 4.
   - *Record* the status value.
   - If it is neither `busy` nor `idle`, it currently maps to `unknown`. Adding a mapping needs a decision, in the domain's `mapClaudeAgentsStatus`.
6. **Prompt-derived names (D-013).** Start a new session with a distinctive first prompt (for example `zebra-quartz-lighthouse`) and don't rename it, then repeat step 4.
   - *Record* whether `name` contains words from the prompt.
   - If it does, `cli_name` must stay off by default and needs founder approval before it's offered at all.
7. **Identity.** Repeat step 4 twice, a minute apart. Then quit one session and resume it with `claude --resume`.
   - *Compare:* `sessionId` is identical across reads.
   - *Record* whether `sessionId` changes on resume. If it does, a resumed session shows as one ended session plus a new one.
   - *Compare:* the closed session disappears from the list, which maps to `ended`.
8. **Failure behaviour.**
   - **Timing:** run `time claude agents --json > /dev/null` (bash) or `Measure-Command { claude agents --json | Out-Null }` (PowerShell). *Expect* well under 10 s with several sessions open.
   - **Signed out:** only if a throwaway profile is available, for example `CLAUDE_CONFIG_DIR` pointing to an empty temp folder, if the CLI supports it. Run `claude agents --json; echo "exit=$?"`. *Record* the exit code and whether stderr matches `AUTH_HINT` in `claude-code-process.ts`. Don't record the text itself if it contains paths.
   - **Missing CLI:** once `MC_CLAUDE_PATH` exists (see "Not wired yet"), point it at an absolute path that doesn't exist and run the doctor (step 10). *Expect* `FAILED [cli_missing]`. Until then, this case is covered only by synthetic tests.
9. **Update the code from the findings.** Change the version bounds, mappings and empty-output rule as needed, and add a synthetic fixture for each new shape. Never commit real output. Then run `npm run check`.
10. **Flip and confirm (founder-approved).** Set `REAL_ADAPTER_ENABLED = true`, wire the provider (see "Not wired yet"), then run `npm run connector -- doctor`.
    - *Expect* `claude-code: version X.Y.Z (supported)` and `claude-code: OK 2 session(s) running=1 waiting_for_input=1; skipped 0 entries`. These are the counts from step 4.
    - *Compare* the output with step 4, and confirm it contains no titles, ids or paths.
11. **End to end.** Run `npm run connector -- run` against the local Supabase, then check the dashboard:
    - two sessions, with generated titles and project labels only (no full paths);
    - close one session: within one poll it shows as ended, not completed;
    - make the CLI impossible to find: the host shows "Source not responding", then recovers once the CLI is back.

Record the date, the CLI version, the operating system and each step's result here before changing the status to Browser/device verified.
