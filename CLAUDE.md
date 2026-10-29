# Tavro — project instructions

**Tavro — "Your AI sessions. In sync."** A mobile-first, privacy-first dashboard that tells developers which AI coding sessions are running, waiting, finished, failed or disconnected, and when one needs their attention.

Start every session by reading `docs/ROADMAP.md` (current milestone, next task, blockers). Durable decisions live in `docs/DECISIONS.md`; quality gates and known limitations in `docs/QUALITY.md`; security model in `docs/SECURITY.md`.

## Operating mode (approved by the user 2026-10-29)

- Work autonomously through the roadmap inside this repository: routine code, tests, docs and reversible design decisions need no per-edit approval. Use `/tavro-ship` for every unit of work.
- Git is local only. Commit each verified unit of work. **Never push, add a remote, or deploy.** No AI attribution lines in commits.
- **Ask first** for: anything outside this folder (e.g. `~/.claude/settings.json` hooks), network services, cloud/paid accounts, deployment, enabling the real adapter, remote actions, irreversible data changes, or anything touching corporate policy.
- Specialist agents live in `.claude/agents/`. Spawn them only where an independent read adds value (QA after features, security for sensitive changes). Report honestly which agents actually ran.

## Security baseline — do not change without explicit user approval

- Demo data by default. Every simulated item is flagged `is_demo` and labelled DEMO.
- Real Claude Code adapter disabled (`REAL_ADAPTER_ENABLED=false`, `apps/connector/src/config.ts`) until `npm run test:db` passes.
- No replies, resume, remote approvals, or command channel. Org policy has `allow_remote_control: false`; never build a relay that recreates it.
- No background push, service-worker push, or cloud infrastructure without an approved architecture.
- Transcript content only to a loopback database. Never in notifications, local storage, logs or caches.
- Clients accept only the publishable key; never put privileged keys in frontend code.
- Endpoint protection kills automated browsers and Docker is unresponsive — do not bypass; record the limitation.

## Repository

npm workspaces, TypeScript 6 strict, ESM. Package names stay `@mc/*` (rename rejected: churn without user value).

| Path | Role |
|---|---|
| `packages/contracts` | Zod schemas shared by every client and the connector |
| `packages/domain` | Platform-neutral rules (no DOM/Node/React — lint-enforced). Reused by the future Expo app. |
| `packages/demo` | Deterministic demo simulator |
| `packages/api-client` | `TavroApi`-style interface; Supabase + in-memory demo implementations |
| `apps/web` | React 19 + Vite + React Router + TanStack Query. Styles/tokens in `src/styles.css`, icons in `src/icons.tsx` |
| `apps/connector` | Outbound-only Node connector; mock provider |
| `supabase/` | Migrations, `pair-host` Edge Function, RLS tests (unrun: Docker) |

Put pure logic in `packages/domain` with unit tests; keep React components thin. Match existing comment density and naming.

## Checks

```bash
npm run check                # typecheck + lint + unit tests — must pass before every commit
npm run build -w @mc/web     # production build — run for any web change
npm run test:e2e             # blocked (browser killed by endpoint protection)
npm run test:db              # blocked (Docker)
```

Never weaken or skip a check to get green. Never report a check as passed unless it ran.
