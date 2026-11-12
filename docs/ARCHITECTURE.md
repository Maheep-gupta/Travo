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
| `@mc/domain` | contracts | Yes, unchanged. Lint blocks DOM, Node and React imports here. Since 2026-11-03 it also holds session views (`session-views.ts`), dashboard filters (`dashboard.ts`), pairing confirmation (`pairing.ts`), connection state and retry policy (`connectivity.ts`) and alert bursts (`alert-bursts.ts`). |
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

## Data model (schema v4)

**v4, 2026-11-12: source failure categories (D-026, migration `20261112000001_provider_error_kind.sql`):**
- Adds `hosts.provider_error_kind text`, checked against a fixed list (`PROVIDER_ERROR_KINDS` in `packages/contracts/src/constants.ts`): the seven Claude Code categories from D-025 plus `writes_not_applied`. Null while the source is healthy, and for a failure reported by a v3 connector. A second check requires `provider_error_since` whenever a category is set.
- Replaces `host_heartbeat` with a 5-argument version: `p_provider_error_kind text default null`. It rejects a category on a healthy report and an unknown category (both `22023`), keeps `provider_error_since` semantics, and clears both columns on recovery. A failure can change category without restarting its `since`.
- The default keeps a v3 connector's four-argument call working through an upgrade (PostgREST matches by argument names); its failures are stored without a category and shown with the generic message.
- Clients require exactly v4: the host list selects `provider_error_kind`, which a v3 database doesn't have. The web host pages show the category's title and guidance (`sourceFailureText`, `packages/domain/src/source-failure.ts`).

**v3, 2026-11-02: stale-write guard (spec 4.2 "out-of-order updates: newer wins"):**
- Adds `sessions.observed_at`: when the connector observed the values it writes. Every connector write sends it (`SessionUpsert.observed_at`); clients don't read it, so it isn't in `SessionRow`.
- `sessions_bound_observed_at` (before insert or update) rejects a null with `23502` and clamps values to `now() + 5 minutes` (`OBSERVED_AT_MAX_SKEW_MS`). A host whose clock runs fast therefore can't pin a session for more than 5 minutes once its clock is corrected.
- `sessions_guard_update` keeps its v1 immutable-column checks and then **skips** (returns null) an update whose `observed_at` is older than the stored one. No error, no new row version, no Realtime change, and the row is missing from `RETURNING`. Rejecting would fail the connector's whole batch over one late row and make it report the backend as offline.
- Equal `observed_at` is applied, so an identical retry is a no-op in effect. An update that omits `observed_at` keeps the stored value and so counts as equal; the connector always sends it.
- Rows that existed before v3 get `-infinity`, so the first v3 write wins.
- Connector: a row missing from the upsert result gets no event, no messages and no update to its in-memory `known` state, so the next cycle retries with a newer observation. This also covers the derived "ended" write. `MemoryTransport` mirrors the database rule so connector tests exercise it; the browser demo backend skips a sync whose clock is behind the last one.
- Persistent skipping (or writes failing after a good heartbeat) for 3 cycles makes the connector report its source as not responding (`SKIPPED_WRITES_LIMIT`, D-015), so frozen statuses never look current.
- v3 grants UPDATE on the conflict-key columns (`host_id`, `provider`, `external_id`) because PostgREST upserts set every payload column; the trigger still rejects any change to them.
- Where late writes come from: two connector processes for one host overlapping (e.g. during a restart), a request held by a proxy and committed after its retry, or a host clock that stepped back. Within one process writes are sequential, so the guard only matters across those cases.
- Session events: `(session_id, dedupe_key)` is already unique, and the connector derives keys from the observation time, so a retried or reordered insert can't duplicate a row. Events are a timeline ordered by `occurred_at`, so a late insert lands in its place without changing session status. Not guarded in the database: an event insert is not compared with the session's `observed_at`, so an event delayed in transit after its session write landed is still stored (and can still raise an alert). Two overlapping connector processes whose writes each landed also both record their transitions, under different keys. Accepted: the connector never emits events for skipped writes, and adding the check would put a session lookup on every event insert for a rare case.
- Clients require exactly v3 (`MIN_SCHEMA_VERSION = MAX_SCHEMA_VERSION = 3`), for the same reason as v2: no project has applied v2 publicly, and a v2 database would fail every connector write (unknown column).

**v2, 2026-11-02:**
- Adds `hosts.provider_error_since` (session source health).
- Replaces `host_heartbeat` with a 4-argument version (replaced again in v4).

**Migration recovery:**
- There are no down-migrations.
- On a local project, `npm run db:reset` rebuilds from all migrations.
- On a user's own project, a failed v3 apply leaves `app_meta.schema_version = 2`. The app then refuses to run, with a "Database needs attention" message, instead of misreading data.
- Unverified: whether the Supabase CLI applies each migration file in one transaction. Check this when Docker works, before relying on it.

Base tables (v1):

The tables are:
- `app_meta`
- `hosts`
- `host_pairings`, which clients can't access at all
- `sessions`
- `session_events`, where `(session_id, dedupe_key)` is unique
- `session_messages`
- `notification_prefs`

The full definitions are in `supabase/migrations/20261029000001_schema_v1.sql`. The supported schema range is declared in `@mc/contracts` (`MIN_SCHEMA_VERSION` / `MAX_SCHEMA_VERSION`). Clients refuse to run against a project whose schema version is outside that range.
