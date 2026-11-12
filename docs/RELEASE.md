# Releasing Tavro

**Status (2026-11-03):** no release has been made. Nothing is deployed, tagged or published. This document says how a release is cut and what it contains. Provisioning and deployment are in `docs/DEPLOYMENT.md`, and the quality gates and their verified or unverified status are in `docs/QUALITY.md`. Pushing, tagging on the remote and deploying all need founder authorization (D-005, D-017).

## Versioning

Tavro uses [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`. While the version is `0.x`, a minor bump may break things.

| Bump | When |
|---|---|
| PATCH | Fixes with no change to the schema, the connector protocol or stored data. |
| MINOR | New features, a new migration that keeps `schema_version`, or a new connector option with a safe default. |
| MAJOR (from 1.0) | A new `schema_version` that old clients refuse, or a breaking change to the connector's configuration. |

Independently of the app version, a migration that changes what clients see raises `schema_version` (`MAX_SCHEMA_VERSION` in `packages/contracts/src/constants.ts`, currently 4). Clients require exactly that version, so web and connector must ship together with it.

**Where the version comes from:**
- **Web app:** `version` in `apps/web/package.json`. `apps/web/src/app-info.ts` imports it as `APP_VERSION`, and **Settings → Application** shows it, next to the Vite build mode (`production` for a release build).
- **Connector:** the `VERSION` constant in `apps/connector/src/cli.ts`. This is **not** read from `apps/connector/package.json`, so bump both together. The connector reports it as `connector_version` on its host row.
- The root `package.json` (`tavro`) is private and unversioned.

Today all three versions are `0.1.0`. Bump them in the release commit, and keep web and connector on the same version.

## Release steps

1. **Freeze the commit.** Everything for the release is committed, and `git status --short` prints nothing. Record `git rev-parse HEAD`.
2. **Bump versions** (above), commit, and note the changes in that commit's message.
3. **Run the gates** listed in `docs/QUALITY.md` → *Gates for every commit*, at that commit: `npm ci`, then `npm run check:release`. Save the output.
4. **Establish the test:db gate** for that exact commit (`docs/DEPLOYMENT.md` → *The test:db gate*). It runs on a machine with Docker or in CI, and is recorded in `docs/QUALITY.md`.
5. **Walk the release checklist** in `docs/QUALITY.md` → *Release checklist (M9)*. Update each row to what actually ran. A row stays *unverified* unless its check ran.
6. **Tag locally:** `git tag -a v<version> -m "Tavro <version>"`. Pushing the tag needs authorization like any push.
7. **Deploy** by following `docs/DEPLOYMENT.md` from the step that applies: a release with no migration and no function change starts at step 6. **Migrations go first, connectors last.** For schema v4, apply `20261112000001_provider_error_kind.sql` before upgrading any connector: a v4 connector against a v3 project gets PGRST202 on every heartbeat, logs "this project needs schema v4: apply the pending migrations" and its host shows as Disconnected until the migration is applied.
8. **After deployment:** run the post-deploy checks (`DEPLOYMENT.md` steps 9 and 9b), record them in `docs/QUALITY.md`, then delete old Cloudflare deployments except one for rollback (step 8.6).

## Environment and configuration

### Web app (`apps/web`)

The web app reads **no environment variables** at build time or at run time. There are no `VITE_*` variables, and none should be added for keys or URLs, so the same build serves any project (BYOS).

| Input | Where | Effect |
|---|---|---|
| Vite mode | `vite build` (production) or `vite` (development) | `import.meta.env.MODE` is shown in Settings → Application. In dev only, the Setup page pre-fills `http://127.0.0.1:54321`; a production build starts that field empty. |
| Supabase project URL and publishable key | Typed by the user on the Setup page, stored in this browser's local storage (`mc.backend`) | Which project the app talks to. Secret and service-role keys are refused (`packages/api-client/src/connection.ts`). |
| `deploy/cloudflare/_headers` | Generated into `dist/` at deploy time (`DEPLOYMENT.md` step 7) | CSP, HSTS and cache rules. Not part of the build. |

### Connector (`apps/connector`)

Read from the process environment, after loading `apps/connector/.env` if it exists (`apps/connector/src/cli.ts`). Validated by `apps/connector/src/config.ts`; invalid values stop the connector with a message naming the variable. The template is `apps/connector/.env.example`.

| Variable | Default | Allowed | Notes |
|---|---|---|---|
| `MC_SUPABASE_URL` | none | `https://…`, or `http://` to `127.0.0.1` or `localhost` only | Required for `pair` and `run`; not for `demo`. |
| `MC_SUPABASE_PUBLISHABLE_KEY` | none | A publishable key, 20 or more characters | Secret and service-role keys are refused. |
| `MC_PROVIDER` | `mock` | `mock`, `claude-code` | `claude-code` is refused while `REAL_ADAPTER_ENABLED = false` (a code constant, not a variable). |
| `MC_POLL_MS` | `5000` | Integer, 1000 to 60000 | Poll interval in milliseconds. |
| `MC_DATA_DIR` | `.data` | Non-empty path, relative to the connector folder | Holds the host credentials (`host.json`). Git-ignored. |
| `MC_SYNC_TRANSCRIPTS` | `false` | `true`, `false`, `1`, `0` | Transcript excerpts are written only when this is true **and** the backend URL is loopback. |

The connector has no other configuration. The provider's working-tree changes may add options; document them here when they're committed.

### Supabase project

Settings outside the repository (auth, Realtime, API and network settings) are listed in `DEPLOYMENT.md` steps 2 and 3b. Local defaults are in `supabase/config.toml`. The `pair-host` function reads only the platform-injected `SUPABASE_URL` and `SUPABASE_SECRET_KEYS`.

## Reproducible build

- **Node 24.** `package.json` requires `>=24`, and the CI template uses 24. Measured on this laptop: v24.19.0. There's no `.nvmrc`, so record the exact `node --version` with each release's `check:release` output.
- **`npm ci`, never `npm install`,** for a release. It installs exactly what `package-lock.json` records and fails if the lockfile and `package.json` disagree. A change to the lockfile is a reviewed change of its own.
- **Edge Function dependencies** are outside the lockfile. `pair-host` pins `npm:@supabase/supabase-js@2.118.0` to the lockfile's version, and `scripts/edge-function-pins.test.mjs` enforces the match. A `deno.lock` isn't generated yet (`DEPLOYMENT.md` step 5).
- **Build:** `npm run build -w @mc/web` writes `apps/web/dist`. Two builds of the same tree on this laptop (2026-11-03) produced byte-identical files (28 files, SHA-256 compared). Reproducibility across machines or operating systems is *unverified*.
- Ship what `check:dist` checked: upload `dist/` from the same build, with no rebuild in between except to regenerate `_headers`. Don't let a host rebuild from Git (`DEPLOYMENT.md` step 8).

## Rollback

- **Web:** roll back to the previous Cloudflare deployment, which is kept for that purpose (`DEPLOYMENT.md` steps 8.6 and 11). It's static and instant.
- **Connector:** check out the previous tag and run `npm ci` there. Host credentials in `MC_DATA_DIR` are unaffected.
- **Database:** migrations don't roll back automatically. A fresh project can be recreated; later, restore from a dump taken before the migration (`DEPLOYMENT.md` → Operations → Backups). A release that raises `schema_version` therefore can't be rolled back by redeploying old clients alone. Old clients refuse the new version and show "project needs migration".
- **Edge Function:** redeploy the previous tag's `pair-host`, or delete it, which stops pairing only (`DEPLOYMENT.md` step 5).
