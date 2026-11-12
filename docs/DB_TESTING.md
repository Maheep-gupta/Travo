# Running the database security tests

**Status (2026-11-03):** `npm run test:db` has never run. The real adapter and any production database stay blocked until it passes (D-002, D-017, spec 10.4).

**Schema v4 (2026-11-12, D-026):** `rls.test.ts` expects `schema_version = 4` and has a case for the heartbeat's failure categories (known and unknown values, a category on a healthy report, a v3 connector's four-argument call, no owner UPDATE). Like the rest of the file it is **written, not yet run**. The PGlite layer (`supabase/sql-tests`) covers the same behaviour plus the v3 → v4 upgrade path at SQL level.

## Why it can't run here

`test:db` (`supabase/tests/rls.test.ts`) needs `supabase start`, and that needs Docker. On this managed laptop the Docker engine doesn't respond, and endpoint protection must not be bypassed (spec 15.4). Installing WSL, Podman or another container runtime would also need IT approval, so it isn't attempted.

## What the tests need

- A local Supabase stack: Postgres, GoTrue, PostgREST and the Edge runtime, with the migrations applied.
- Its keys, read from `supabase status`.
- Nothing else. There are no secrets, no hosted project and no real session data.

## Options

| Option | What it takes | Verifies everything `test:db` covers? | Policy risk | Recommendation |
|---|---|---|---|---|
| **A. An approved developer machine with Docker** (personal or IT-provided) | `npm ci && npm run db:start && npm run test:db` | Yes | Low, if the machine is approved for this code. The code is already public. | **Recommended for the first run.** It's the fastest and needs no new service. |
| **B. GitHub Actions on the existing public repo** | Activate `deploy/ci/db-tests.yml`. GitHub-hosted runners have Docker. | Yes, on every push | Low. The code is already public, and no secrets or session data are involved. But it starts using a new service (Actions) and runs only after a push, which is founder-gated. | **Recommended as the ongoing gate**, once pushing is authorized |
| C. An organization-approved cloud dev environment (e.g. Codespaces or a company VDI) | Depends on IT. Codespaces bills beyond its free quota. | Yes | Depends on org policy. It may be paid. | Only if IT prefers it |
| D. A hosted Supabase test project | Rewrite `helpers.ts` to take keys from the environment (they currently come from `supabase status`). It also needs the project's secret key on this laptop. | Mostly. The Edge runtime differs. | A new external service, plus a privileged key on a corporate machine | Not recommended. It's founder decision #12 in `GAP_ANALYSIS.md`. |
| E. SQL-level tests in PGlite (Postgres in WASM, no Docker) | An npm dev dependency. It runs in `npm` on this laptop. | **No.** It checks the migrations' triggers, grants and RLS at the SQL level only: no PostgREST, GoTrue or Edge Function. | None | **Done as an extra layer** (see `QUALITY.md`). Never counted as `test:db`. |

## What "done" means

`test:db` counts as passed only when `supabase/tests/rls.test.ts` itself ran against a real local Supabase stack (option A, B or C) and passed. Record the following in `QUALITY.md`:
- the date;
- the machine or CI run;
- the CLI version;
- the output.

A PGlite pass (option E) narrows the risk but doesn't satisfy this.

## Founder decision needed

Pick A, B or C, in that order of preference. Option B also needs push authorization, and the action versions pinned to commit SHAs before it's activated.
