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

**Not implemented yet:** the hook rows, and the adapter that actually calls the CLI.
