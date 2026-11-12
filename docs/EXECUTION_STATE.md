# Execution state

Continuity between sessions. Update it at the end of every cycle. Requirements are in `PRODUCT_SPEC.md`, statuses in `GAP_ANALYSIS.md`, and the plan in `ROADMAP.md` (D-016).

**Last updated:** 2026-11-12, end of the seventh cycle.

## Where things stand

- **Branch:** `main`. The local commits are ahead of `origin/main` (public). They are **not pushed**, because a push needs founder authorization (D-017).
- **Schema:** v4. Clients and connectors require exactly v4. The migration is `20261112000001_provider_error_kind.sql` (D-026). Apply it **before** upgrading any connector (see `DEPLOYMENT.md`).
- **Subagent models (user decision, 2026-11-12):** subagents default to Sonnet through the user-level `CLAUDE_CODE_SUBAGENT_MODEL`. Only `security`, `architect-dev` and `qa` are pinned to Opus.
- **Gates at the last commit:**
  - `npm run check:release` passes: typecheck, lint, 1349 tests (79 SQL-level in PGlite), build, and 242.7 kB gzip against a 270 kB budget.
  - **When the laptop is busy** with the user's other projects (Angular dev servers and test runs), leave those processes alone. The per-test ceilings in `vitest.config.ts` absorb the load.
  - `test:db` and `test:e2e` have never run. The PGlite layer is **not** `test:db` (D-021).

## Seventh cycle (2026-11-12): what was done

- **Team:**
  - Five engineers worked in parallel with separate file ownership: G27 diagnostics and schema v4, G29 setup, G30/G33 (designer), G32 auth, and G24 transitions.
  - QA, security and designer then reviewed the integrated tree.
  - Three engineers fixed the findings: alerts and failure text; auth pinning and the connector; design.
  - The main session handled integration, the label fix and the docs.
- **Delivered:** see ROADMAP "Done 2026-11-12 (seventh cycle)". Decisions D-026 and D-027.
- **Left:**
  - the G30 tap and hover leftovers;
  - `asUser` is not enforced by type;
  - the manual browser and device pass.

## Sixth cycle (2026-11-03): what was done

- **Team:**
  - Four engineers worked in parallel, each owning its own files: session page and dashboard; Alerts page and bursts; session list and API client; accessibility.
  - QA and security then reviewed the integrated tree, and two engineers fixed their findings.
  - The main session fixed the connector's key rule (it now passes the error code) and the docs.
- **Delivered:** see ROADMAP "Done 2026-11-03 (sixth cycle)".
- **New local storage:** the notification burst key (D-018). It holds only counts, kinds and times. It is listed in Settings and removed on sign-out, user switch, Clear and open.

## Fifth cycle (2026-11-03): what was done

- **Team:**
  - Three engineers implemented in parallel, each owning its own files: partial data, sleep/resume, and the Claude Code provider.
  - Three ran read-only reviews: a full spec audit, a critical phone-access security review, and a mobile UX review.
  - Two more then fixed what the reviews found: deployment and runbook, and database and Realtime.
  - QA and security then reviewed the integrated tree; two engineers fixed their findings.
  - The main session made the mobile CSS and copy fixes, the pill, capability honesty, connector wiring, transcript-refusal handling, test ceilings and all docs.
- **Delivered:** see ROADMAP "Done 2026-11-03 (fifth cycle)". Decisions D-022 to D-025.
- **Migrations:**
  - `20261105000001_security_hardening.sql` is new. It is SQL-level tested, **not** run on a real stack.
  - The schema version stays 3.
- **Open after review (G32):**
  - QA LOW-3 and LOW-4 from cycle 4;
  - backlog items L2, L3, I1 and I3;
  - the copy of `isKeyRejection` in the connector;
  - `liveUpdates` tracks only the newest subscription.

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

1. The remaining local gaps, in the order given in ROADMAP "Next cycle" (G27 first).
2. **When authorized:** follow `docs/DB_TESTING.md`, then `docs/DEPLOYMENT.md`. Both start with gates that can't be skipped.
3. **Before the real adapter:** run the checklist in `docs/INTEGRATIONS.md`, then founder approval.

Also done late in this cycle: G13 request timeout, G14 unread alerts on the dashboard, G15 search, G17 bundle budget and `check:dist`, G19 `_headers` template and deployment runbook.

**How to continue:**
1. Read this file, `ROADMAP.md` and `GAP_ANALYSIS.md`.
2. Check `git status` and `git log`.
3. Run `npm run check`.
4. Use `/tavro-ship` for each unit. Split parallel work by file ownership, and have QA and security review anything touching auth, storage, the connector or migrations.

## Founder decisions pending

These are recorded once in `GAP_ANALYSIS.md` ("Founder decisions pending") and D-017: push, licence, D-013, `npm audit`, phone access (IT clearance, Supabase project, hosting, deployment), Docker, a browser/device check, hooks, M6 push, transcripts (D-004 vs spec 4.3), and BYOS sign-ups.
