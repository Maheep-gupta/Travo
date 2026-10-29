# Tavro

**Your AI sessions. In sync.**

A mobile-first dashboard for monitoring Claude sessions running on your laptop.

**Current state (2026-10-29): local-first MVP, demo data only.**

- The web dashboard and the connector work with **simulated** sessions.
- The database layer (Supabase schema and security policies) is written but **not yet verified**, because Docker isn't responding on the development laptop.
- The real Claude Code adapter stays **disabled** until the database isolation tests have passed.
- Replies, remote approvals, push notifications and cloud connectivity are **out of scope** for this release.

For details, see [docs/FEASIBILITY.md](docs/FEASIBILITY.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Layout

```
apps/web            React + Vite + React Router + TanStack Query dashboard (PWA manifest, light/dark)
apps/connector      Node connector on the laptop; outbound-only; mock provider today
packages/contracts  Zod schemas shared by every client and the connector
packages/domain     Platform-neutral rules: statuses, connectivity, capabilities, content guard, filters
packages/demo       Deterministic simulator of demo sessions (clearly labelled)
packages/api-client Typed client: Supabase implementation + in-memory demo implementation
supabase/           config.toml, versioned migrations, pair-host Edge Function, RLS integration tests
docs/               ARCHITECTURE, FEASIBILITY, INTEGRATIONS, SECURITY, BYOS
```

## Requirements

- Node.js 24+ and npm 11. No global installs: the Supabase CLI is a project dev dependency.
- Docker Desktop, needed **only** for the local Supabase stack (`npm run db:start`).

## Quick start (demo, no Docker)

```bash
npm install
npm run dev:web            # http://127.0.0.1:5173 → "Open demo"
npm run connector -- demo  # connector with mock provider + simulated outages, no network
```

Demo mode runs entirely in the browser. Every session, event and message is labelled **DEMO**. You can also open `http://127.0.0.1:5173/?demo=1` to go straight into demo mode. This never overrides a backend you've already saved.

UI design tokens and component styles live in `apps/web/src/styles.css`, which is dark-first with a light theme that follows the system setting. Icons are in `apps/web/src/icons.tsx`.

## Checks

```bash
npm run typecheck   # all workspaces + DB tests
npm run lint
npm test            # unit tests (no Docker)
npm run build -w @mc/web
npm run test:e2e    # build + 65 browser checks in local headless Chrome (see apps/web/e2e/README.md)
npm run test:db     # RLS/isolation tests; requires `npm run db:start`
```

## Local Supabase (once Docker works)

```bash
npm run db:start                 # first run downloads ~1–2 GB of images
npm run db:status                # shows API URL + publishable key (never use the secret key in apps)
npm run db:reset                 # applies supabase/migrations to a clean database
npm run test:db                  # must pass before any real data is used
```

Then:

1. Copy `apps/connector/.env.example` to `apps/connector/.env` and fill in the URL and the **publishable** key.
2. In the web app, choose "Connect your Supabase project" with the same values and sign in. Create the user in local Studio at http://127.0.0.1:54323.
3. On the **Hosts** page, create a pairing code, then run `npm run connector -- pair <CODE>` followed by `npm run connector -- run`.

## Phone access

Not available yet. The app only listens on `127.0.0.1`, and there's no VPN and no cloud deployment. Cloud use needs a company-policy review first; see [docs/BYOS.md](docs/BYOS.md) and [docs/SECURITY.md](docs/SECURITY.md).
