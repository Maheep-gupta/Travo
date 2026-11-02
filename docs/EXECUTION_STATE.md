# Execution state

Continuity between sessions. Update it at the end of every cycle. Requirements are in `PRODUCT_SPEC.md`, statuses in `GAP_ANALYSIS.md`, and the plan in `ROADMAP.md` (D-016).

**Last updated:** 2026-11-02, end of the third cycle.

## Where things stand

- **Branch:** `main`. The local commits are ahead of `origin/main` (public). They are **not pushed**, because a push needs founder authorization (D-017).
- **Schema:** v3 (`supabase/migrations/20261103000001_stale_write_guard.sql`). Clients require exactly v3.
- **Gates at the last commit:**
  - `npm run check` (typecheck, lint and 351 tests) passes.
  - `npm run build -w @mc/web` passes.
  - `test:db` and `test:e2e` have never run.

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
| Docker unresponsive | `test:db` (RLS, v2/v3 triggers, pairing end to end) never ran, so the real adapter stays disabled | Founder or IT fix, or an authorized hosted test project |
| Endpoint protection kills automated browsers | No `test:e2e`, no visual, contrast, install or notification checks | A manual check, or an approved browser |
| No deployment | No phone access, which is the core promise | Founder decisions in `PHONE_ACCESS.md` §5 |

## Next actions (in order)

1. **G13, reliability edges.** Add a fetch timeout to the Supabase client via a custom `fetch` with `AbortSignal.timeout`. Present partial data when one query fails. Add a sleep/resume test.
2. **G19, phone-access local preparation.** A `_headers` template, a deployment runbook, a "project paused or unreachable" state, and refetch when the page becomes visible.
3. **G14, G15, G16, G17, G18, G20.** See `GAP_ANALYSIS.md`.

**How to continue:**
1. Read this file, `ROADMAP.md` and `GAP_ANALYSIS.md`.
2. Check `git status` and `git log`.
3. Run `npm run check`.
4. Use `/tavro-ship` for each unit. Split parallel work by file ownership, and have QA and security review anything touching auth, storage, the connector or migrations.

## Founder decisions pending

These are recorded once in `GAP_ANALYSIS.md` ("Founder decisions pending") and D-017: push, licence, D-013, `npm audit`, phone access (IT clearance, Supabase project, hosting, deployment), Docker, a browser/device check, hooks, M6 push, transcripts (D-004 vs spec 4.3), and BYOS sign-ups.
