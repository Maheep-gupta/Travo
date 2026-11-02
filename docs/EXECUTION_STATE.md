# Execution state

Continuity between sessions. Update it at the end of every cycle. Requirements are in `PRODUCT_SPEC.md`, statuses in `GAP_ANALYSIS.md`, and the plan in `ROADMAP.md` (D-016).

**Last updated:** 2026-11-03, end of the fourth cycle.

## Where things stand

- **Branch:** `main`. The local commits are ahead of `origin/main` (public). They are **not pushed**, because a push needs founder authorization (D-017).
- **Schema:** v3. Clients require exactly v3. The latest migration, `20261104000001_fix_set_owner_from_host.sql`, changes a function body only and leaves the version at 3.
- **Gates at the last commit:**
  - `npm run check` passes: typecheck, lint and 534 tests, of which 50 are SQL-level tests in PGlite.
  - `npm run check:release` passes: 223.7 kB gzip against a 270 kB budget.
  - `test:db` and `test:e2e` have never run. The PGlite layer is **not** `test:db` (D-021).

## Fourth cycle (2026-11-03): what was done

- **Agents:** four ran in parallel with separate file ownership:
  - paused/unavailable state and the connectivity move;
  - sign-in review;
  - moving shared logic into the domain;
  - the PGlite SQL tests.

  The main session built burst grouping. QA and security then reviewed the integrated tree. One agent fixed the security and sign-in findings; the main session fixed QA's burst and banner findings. Security re-checked the token-leak fix.
- **Delivered:**
  - G16 bursts (D-018);
  - paused, unavailable and refused-response states, with bounded retries (D-019);
  - G20 sign-in lifecycle (D-020);
  - G18 domain move;
  - the PGlite layer, which found the v1 trigger defect G21, fixed (D-021);
  - `docs/DB_TESTING.md`;
  - the inactive CI template `deploy/ci/db-tests.yml`.
- **Review findings fixed:**
  - Security M1: session tokens could reach another project after Change backend.
  - Security L1–L3 and I1.
  - QA H1: approvals could be notified silently mid-burst.
  - QA M1: a summary closed an unseen notification it didn't count.
  - QA M2: refused responses blamed the connection.
  - QA LOW-1, 2, 5, 6, 7 and 8.
- **Left, as follow-ups:**
  - QA LOW-3: two hidden tabs split one burst.
  - QA LOW-4: a duplicate paused message before the first load.
  - The other account's empty responses can't be told apart.
  - auth-js counts a 401 from `/logout` as success.

## Third cycle (2026-11-02): what was done

- **Agents:** four ran in parallel with separate file ownership (freshness and session alerts; offline banner and Settings; stale-write guard; phone-access research). QA and security then reviewed independently, and a fifth agent fixed their web findings. The main session fixed the connector and migration findings.
- **Delivered:**
  - G4: visible freshness, capped by the client's own fetch time.
  - G5: offline banner.
  - G7: session ↔ alerts.
  - G10: Settings sections, Setup onboarding and pairing confirmation.
  - G12: schema v3 stale-write guard (D-015).
  - The theme script moved to `public/theme-init.js`, so a strict CSP needs no hash.
  - `docs/PHONE_ACCESS.md`.
- **Review findings fixed:**
  - QA H1: stale session list shown as current.
  - QA M1: offline client blamed the laptop.
  - QA M2 and security M1: skipped or failing writes looked healthy.
  - Security M2: missing upsert column grants.
  - QA M3: flaky pairing test.
  - QA L1: missing failure-path tests.
  - Security L2 and L3: privacy copy.

## Blockers

| Blocker | Effect | Needs |
|---|---|---|
| Docker unresponsive | `test:db` never ran, so the real adapter stays disabled. SQL-level checks run in PGlite, but PostgREST, GoTrue and pairing end to end are unverified. | Founder choice from `docs/DB_TESTING.md`: an approved Docker machine (A), or GitHub Actions (B, needs push) |
| Endpoint protection kills automated browsers | No `test:e2e`, no visual, contrast, install or notification checks | A manual check, or an approved browser |
| No deployment | No phone access, which is the core promise | Founder decisions in `PHONE_ACCESS.md` §5 |

## Next actions (in order)

1. **G13:** present partial data when one query fails, and add a sleep/resume test.
2. **Full spec re-audit**, then the highest-value gaps it finds.
3. **QA LOW-3 and LOW-4** (see above).
4. When authorized: follow `docs/DB_TESTING.md`, then `docs/DEPLOYMENT.md`.

Also done late in this cycle: G13 request timeout, G14 unread alerts on the dashboard, G15 search, G17 bundle budget and `check:dist`, G19 `_headers` template and deployment runbook.

**How to continue:**
1. Read this file, `ROADMAP.md` and `GAP_ANALYSIS.md`.
2. Check `git status` and `git log`.
3. Run `npm run check`.
4. Use `/tavro-ship` for each unit. Split parallel work by file ownership, and have QA and security review anything touching auth, storage, the connector or migrations.

## Founder decisions pending

These are recorded once in `GAP_ANALYSIS.md` ("Founder decisions pending") and D-017: push, licence, D-013, `npm audit`, phone access (IT clearance, Supabase project, hosting, deployment), Docker, a browser/device check, hooks, M6 push, transcripts (D-004 vs spec 4.3), and BYOS sign-ups.
