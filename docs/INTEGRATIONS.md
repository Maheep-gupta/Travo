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

## Planned Claude Code mapping (after RLS verification)

| Source | Our status | Notes |
|---|---|---|
| `claude agents --json` `status: "busy"` | `running` | Verified output on this laptop (CLI 2.1.312) |
| `status: "idle"` | `waiting_for_input` | Idle at the prompt: the turn is finished or it's waiting for you. **Not** `completed`. |
| Any other value | `unknown`, with the raw value as the reason | Never guessed |
| Session no longer listed | `ended` (derived) | Not `completed` |
| `Notification` hook with `permission_prompt` | `approval_required` | Requires the user to approve hooks |
| `StopFailure` hook | `failed` | Requires hooks |

**What exists today:**
- The `busy`, `idle` and unknown-value rows are implemented as pure logic in `@mc/domain` (`mapClaudeAgentsStatus`) and covered by unit tests.
- The "no longer listed → ended" rule is implemented in the connector and tested with the mock provider.
- **The adapter exists but is disabled** (`apps/connector/src/providers/claude-code.ts`, added 2026-10-30). It isn't wired into the CLI and `REAL_ADAPTER_ENABLED` is still `false`. 34 unit tests run it against **synthetic** sample output (`apps/connector/test/fixtures/claude-agents/`). Behaviour:
  - Output is validated with zod. Malformed entries are skipped and counted; empty or non-array output is treated as a failure, so one bad read can't mark every session ended.
  - No transcript or summary text is read.
  - The project label is the last folder of `cwd` only, and is dropped for home folders (`/home/<user>`, `C:\Users\<user>`, …) because that segment would be the account name.
  - Text is stripped of control characters and capped to the contract limits.
  - The command runs as `execFile("claude", ["agents", "--json"])`, with no shell, a timeout of 10 s or less and at most 1 MB of output. Errors are fixed messages that never echo the command's output.

**Not implemented yet:** the hook rows.

**Must be verified live before enabling** (after `npm run test:db` passes and the user approves the flag flip):
- the exact output shape and key names;
- what the CLI prints when no sessions are open (if it prints nothing rather than `[]`, the empty-output rule must change);
- whether a timestamp field exists;
- the status shown while a permission prompt is open;
- exit codes and how long the call takes;
- on Windows, how to locate `claude.cmd`, because `execFile` without a shell can't run it (never fix this with `shell: true`);
- whether session `name` values can be derived from prompt content, which matters for D-004 and D-013.

The connector should also get a provider-error state, so that a CLI failure isn't reported as the backend being offline.
