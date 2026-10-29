# Feasibility audit

**Date:** 2026-10-29
**Machine:** Windows 11, managed office laptop. Claude Code 2.1.312, via the VS Code extension. claude.ai Team subscription.

Evidence labels:
- **Tested**: run on this machine.
- **Docs**: official documentation.
- **Unverified**: not yet confirmed.

## 1. Confirmed to work

| Capability | Evidence |
|---|---|
| `claude agents --json` lists live interactive sessions with `pid`, `cwd`, `sessionId`, `name` and `status` (`busy` / `idle`) | **Tested**: returned 3 sessions |
| Claude Code hooks (`Notification` with `permission_prompt` / `idle_prompt`, `Stop`, `StopFailure`, `SessionStart`, `SessionEnd`), including `type: "http"` hooks | **Docs**: code.claude.com/docs/en/hooks |
| Agent SDK `listSessions` / `getSessionMessages` read local transcripts | **Docs**: code.claude.com/docs/en/agent-sdk/sessions |
| `claude -p --resume <id> --output-format stream-json` continues a session | **Docs**: code.claude.com/docs/en/headless |
| Outbound HTTPS to the major cloud hosts; no proxy; certificates from public CAs | **Tested** with HEAD requests |

## 2. Tested locally in this repository

| What | Result |
|---|---|
| Unit tests: contracts, domain, demo simulator, api-client, connector, web view model | Pass (see the latest report) |
| Type checks (strict) for all workspaces, plus the DB test code | Pass |
| ESLint, including the platform-neutrality rules | Pass |
| Production build of the web app | Pass |
| Connector `demo`: mock provider, simulated network loss, backoff, reconnect | Pass (observed; no duplicate events) |
| Built app served over HTTP: index, deep link, bundle; no secret keys in the bundle | Pass |
| **Supabase migration, RLS isolation tests, `pair-host` function, Realtime isolation** | **Not run.** Docker engine doesn't respond. |
| **Browser viewport checks (`npm run test:e2e`)** | **Not run.** Headless Edge and Chrome are terminated about 2.5s after launch (likely endpoint protection). Not bypassed. |

## 3. Needs authentication, a subscription or configuration

- **Remote Control** needs a Pro, Max, Team or Enterprise plan and Owner enablement. **Your organisation has it disabled** (`allow_remote_control: false` in `~/.claude/policy-limits.json`).
- **Agent SDK in third-party apps:** the docs say to use an API key, not a claude.ai login. This doesn't matter today because replies are disabled.
- **Hooks** require editing `~/.claude/settings.json`, a global file. Not approved yet.
- **Local Supabase** requires a working Docker engine.

## 4. Unavailable or uncertain

- Replying to an open terminal or VS Code session: no supported API (**Docs**). Remote Control is the only route, and it's disabled by policy.
- Claude Desktop and Cowork session enumeration or control: no API (**Docs**). Dispatch isn't available on Team plans.
- claude.ai browser conversations: no official API. Scraping and cookie extraction are refused by design.
- Whether hooks fire identically in VS Code and Desktop sessions: **unverified**.
- What `claude agents --json` reports while a permission prompt is open: **unverified**. It maps to `unknown` until observed.
- Whether connector heartbeats keep a Supabase Free project from pausing: **unverified**. Not relied on.

## 5. Recommended integration per environment

| Environment | Integration |
|---|---|
| Claude Code (terminal / VS Code) | Read-only: `claude agents --json` polling, plus optional hooks, plus SDK transcript reads to a loopback DB |
| Claude Desktop (Code tab) | Same as Claude Code, if hooks are approved. Otherwise link out. |
| Cowork | Link out only |
| claude.ai | Link out only |

## 6. Test plan for the remaining items

1. **Docker / Supabase:** start Docker Desktop, then run `npm run db:start`, `npm run db:reset` (clean apply) and `npm run db:lint`. Then `npm run test:db`, which covers about 20 isolation tests. **Must pass before the real adapter is enabled.**
2. **Pairing end to end:** create a code in the web app, run `connector pair`, run `connector run`, and watch demo sessions appear live in the dashboard. Then revoke the host and confirm the connector loses access immediately.
3. **Real adapter** (after step 1): implement it with `claude agents --json`. With a session open, compare the dashboard against what the terminal shows for busy, idle and close. Observe the status while a permission prompt is open.
4. **Viewports:** either get approval for a browser the automation tooling is allowed to drive, or check manually at 360 and 390 px in DevTools device mode.
5. **Hooks (optional, needs approval):** install them through a preview-and-confirm script, then confirm `permission_prompt` and `StopFailure` reach the connector from a VS Code session.
