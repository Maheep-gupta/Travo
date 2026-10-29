# Architecture

## Components

```
Web app (React)  ─┐                          ┌─ Future: React Native + Expo app
                  │ publishable key + user JWT│
                  ▼                          ▼
        ┌──────── Supabase project (local now; user-owned BYOS later) ────────┐
        │ Auth · Postgres + RLS · Realtime (Postgres Changes) · Edge Function │
        └──────────────────────────────────────────────────────────────────────┘
                  ▲ outbound HTTPS/WSS only, host JWT
        Local connector (Node, on the laptop) ── Provider (mock | claude-code*)
```

\* `claude-code` is disabled until the database isolation tests pass.

There's no separate application server. Following the approved BYOS decision (docs/BYOS.md), authorisation lives in Postgres row-level security. The one privileged operation, pairing a host, runs in the `pair-host` Edge Function on the Supabase side.

## Packages and what React Native will reuse

| Package | Depends on | Reused by the mobile app |
|---|---|---|
| `@mc/contracts` | zod | Yes, unchanged |
| `@mc/domain` | contracts | Yes, unchanged. Lint blocks DOM, Node and React imports here. |
| `@mc/demo` | contracts | Yes (demo mode) |
| `@mc/api-client` | contracts, domain, demo, supabase-js | Yes. The mobile app supplies its own `KeyValueStorage` (expo-secure-store). |
| `apps/web` | all of the above, plus React DOM, TanStack Query, React Router | No. The mobile UI is written separately with React Native components. |
| `apps/connector` | contracts, domain, demo, api-client (config schema) | Not applicable (laptop only) |

**What the mobile app must implement itself:**
- screens
- navigation (Expo Router)
- secure storage of the token (SecureStore adapter for `KeyValueStorage`)
- push registration (Expo push token), once push is approved
- deep links

## Key decisions

| Decision | Why | Revisit when |
|---|---|---|
| npm workspaces, not pnpm | pnpm needs a corepack shim installed globally, and global changes weren't approved | Never needed |
| BYOS / Supabase instead of Fastify + Postgres | User decision. Means zero hosting for the developer and authorisation enforced in the database. | A requirement appears that RLS can't express |
| Hosts are separate Supabase Auth users with `app_metadata.mc_role = "host"` | Least privilege. `app_metadata` can't be written by clients, and revocation is enforced by RLS without waiting for the token to expire. | Never |
| Owner is set by trigger on host-written rows | A host can't assign data to another owner | Never |
| A host whose heartbeat is older than 90s shows its sessions as "Disconnected" | Stored status is untrustworthy without a live host, and inactivity is never treated as completion | Real heartbeat data is available |
| Session gone from the provider becomes `ended` (`status_source = derived`) | Disappearing doesn't mean the task succeeded | Hooks provide a real Stop or SessionEnd event |
| Transcript excerpts only go to a loopback database | Approved constraint: content stays on the laptop | A cloud policy is approved |
| Connector has no inbound interface | No remote commands in this release; it only polls the provider and writes out | Remote commands are approved |
| Demo backend runs in the browser | Lets the UI be built and tested without Docker or any network | Never |
| TypeScript 6.0, not 7 | typescript-eslint supports TypeScript below 6.1 | typescript-eslint supports TS 7 |
| Short JWT lifetime (15 minutes, `config.toml`) | Realtime caches its permission checks until the token expires | Never |
| Live updates: Supabase Realtime, used to trigger query refetches | Realtime respects RLS. Data is always re-read through RLS-checked queries rather than trusted from the change payload. | Never |

## Data model (schema v1)

The tables are:
- `app_meta`
- `hosts`
- `host_pairings`, which clients can't access at all
- `sessions`
- `session_events`, where `(session_id, dedupe_key)` is unique
- `session_messages`
- `notification_prefs`

The full definitions are in `supabase/migrations/20261029000001_schema_v1.sql`. The supported schema range is declared in `@mc/contracts` (`MIN_SCHEMA_VERSION` / `MAX_SCHEMA_VERSION`). Clients refuse to run against a project whose schema version is outside that range.
