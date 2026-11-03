# Tavro gap analysis (requirements traceability matrix)

**Requirements source:** `docs/PRODUCT_SPEC.md` v1.0. Requirement IDs are the spec section numbers (D-016).
**Last updated:** 2026-11-03, fifth cycle. This version includes a full spec audit by the product-manager role, which corrected several earlier claims, marked ✱.
**Owner:** product-manager role; statuses are updated by the main session after integrating each cycle.
**Test baseline:** `npm run check:release` passes. That covers typecheck, lint, the build, bundle budgets and 835 tests:
- unit;
- component (jsdom, with axe but no colour contrast);
- 71 SQL-level tests in PGlite (D-021), which are **not** `test:db`.

`test:db` has never run (Docker is blocked). `test:e2e` has never run (browser automation is blocked).

## Status labels (founder directive of 2026-11-03)
- Not started · In progress · Implemented
- **Unit-test verified:** a named test in `npm test` exercises the requirement in isolation. Component tests in jsdom count here.
- **Integration-test verified:** a named test runs several real modules together (connector + transport + provider, page + banner + query client, the real supabase-js against a stubbed fetch). PGlite SQL tests are integration-level for the migrations, and **never** Database verified.
- **Database verified:** `test:db` passed on a real local Supabase stack. **Nothing yet.**
- **Browser verified · Device verified:** **nothing yet**, because browser automation is blocked and nothing is deployed.
- **Security verified:** an independent security review found no open High or Critical issue, **and** the database parts are Database verified. **Nothing yet.**
- **Production ready:** every gate in spec Part 21 and the directive's completion gates is met. **Nothing yet.**
- Blocked (reason) · Needs founder decision

## Status by area

### Product and navigation (Parts 1–2)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 1.1/1.3 | Purpose, users | Unit-test verified | `SetupPage.dom.test.tsx` "explains what Tavro does…" |
| 1.2 | Principles: no false reassurance, honest capabilities | Unit-test verified | ✱ Previously breached by the headline, the pill and the Claude Code capability claim. All three fixed this cycle (D-023, `connectionIndicator`, `capabilities.ts`). |
| 1.4 | Phone access | Blocked (founder decisions) | Architecture reviewed critically on 2026-11-03 (`PHONE_ACCESS.md`, `DEPLOYMENT.md`). Provisioning needs authorization. |
| 2 | Product areas | Implemented | ✱ There is no separate "Diagnostics and connection health" area. Per-host health is on the host pages, and connector diagnostics come from `npm run connector -- doctor` (adapter-gated). **G27** |
| 2.1 | Navigation; backend indicator agrees with sync state | Integration-test verified | `statusIndicator` (`data-availability.test.ts`); `partial-data.dom.test.tsx` asserts the pill ("Incomplete", "Not refreshing", recovery); `route-focus.dom.test.tsx`. ✱ The pill used to say "Connected" while offline or while a list failed. Layout: Blocked (browser). |

### Dashboard (Part 3)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 3.1 | Counts per state and total; no misleading aggregates | Unit-test verified | ✱ Fixed this cycle (D-023): `dashboard-headline.test.ts`; `partial-data.dom.test.tsx` headline cases (current, offline, stale over 90 s, all hosts offline); "Counts as of HH:MM"; "Nothing confirmed needs you — N sessions can't be confirmed" when sessions sit on untrusted hosts. The state chips show 0 for Disconnected and Source not responding while hosts are missing, explained by the notice but not marked on the chips (**G22**). |
| 3.2 | Card fields, freshness, no paths | Unit-test verified | `DashboardPage.dom.test.tsx`, `freshness.test.ts`, `claude-code.test.ts` |
| 3.3 | Filters and search in the URL | Unit-test verified | `view-model.test.ts`, `DashboardPage.dom.test.tsx`. ✱ The session page's "Sessions" link drops the active filters (**G23**). |
| 3.4 | Sorting | Unit-test verified | `dashboard.test.ts`, `domain.test.ts` |
| 3.5 | First-time empty; no hosts vs no sessions | Unit-test verified | ✱ These were not distinct before this cycle. `partial-data.dom.test.tsx` covers both empty states. |
| 3.5 | Loading; recoverable and complete error | Unit-test verified | `partial-data.dom.test.tsx` Dashboard loading/failed; page dom tests |
| 3.5 | Partial data (one list failing; a failed refresh keeps cached data) | Integration-test verified | D-023. `data-availability.test.ts`; `partial-data.dom.test.tsx` (25 tests, including page + banner through an outage and its recovery) |
| 3.5 | Offline; auth expired; source unavailable | Unit-test verified | `offline-banner.dom.test.tsx`, `client-freshness.dom.test.tsx`, `auth.dom.test.tsx`, `SessionPage.dom.test.tsx` |
| 3.5 | Demo data never looks real | Unit-test verified | `demo.test.ts`, `api-client.test.ts` |

### Sessions (Part 4)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 4.1 | States; session state separate from source health; a failed read never becomes completed | Integration-test verified | `connector.test.ts`, `claude-code-connector.test.ts`, `session-views.test.ts` |
| 4.2 | No duplicate transitions; retried transitions keep their key | Integration-test verified | D-024. `sleep-resume.test.ts` (connector), `connector.test.ts` |
| 4.2 | No false transitions after sleep or network interruption | Integration-test verified (synthetic clocks) | D-024. `packages/domain/test/sleep-resume.test.ts`, `apps/connector/test/sleep-resume.test.ts`, `apps/web/src/sleep-resume.dom.test.tsx`. The grace is granted once per heartbeat, so repeated short looks at a dead host still alert (QA fix). A sleep shorter than 90 s can still produce a disconnect/reconnect pair. |
| 4.2 | Out-of-order updates: newer wins | Integration-test verified (SQL level + connector); Database verified: Blocked (Docker) | D-015. `migrations.test.ts` "stale-write guard"; `rls.test.ts` not run |
| 4.2 | Transition rules (approval → working only after a genuine update; completed → new lifecycle) | Not started | ✱ No explicit transition model (**G24**, lower value) |
| 4.3 | Session detail, source health, last update, related alerts | Unit-test verified | `SessionPage.dom.test.tsx`, `partial-data.dom.test.tsx` |
| 4.3 | Transcript excerpts (spec) vs D-004 | Needs founder decision | The database now refuses transcripts unless enabled locally (D-022) |
| 4.4 | No remote commands; read-only capabilities enforced by the database | Integration-test verified (SQL level) | D-022. `connector.test.ts` "never grants control capabilities"; `migrations.test.ts` capabilities check |
| 4.4 | Dismiss and read a session's alerts from its page | Not started | ✱ **G25** |

### Alerts and notifications (Part 5)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 5.1/5.3/5.4 | Alerts from genuine changes; identity, dedupe, cap, tabs, account isolation | Unit-test verified | `alerts.test.ts`, `alerts.dom.test.tsx`, `auth.dom.test.tsx`. Real tabs: Blocked (browser). |
| 5.2 | Categories | Implemented (partial) | ✱ There is no "important connector error" category. With the real CLI only Waiting/Working are observable: Needs approval, Completed and Failed need Claude Code hooks (founder decision 7). |
| 5.5 | Notification centre | Unit-test verified | `alerts.dom.test.tsx`. ✱ While names are loading, rows say "no longer listed" (**G26**). |
| 5.6 | System notifications: foreground, opt-in, generic, honest about phones | Unit-test verified (synthetic) | `SettingsPage.dom.test.tsx`, `alerts.test.ts`. The copy now says phones may not show them without a service worker. Real browsers and devices: Blocked. |
| 5.6 | Session names in notifications (D-013) | Needs founder decision | Built and inactive |
| 5.7 / 16 | Bursts; no storms | Unit-test verified | D-018. `alert-bursts.test.ts`, `alerts.dom.test.tsx` |
| 5.7 | Push, quiet hours | Blocked (M6, cloud and IT approval) | `PHONE_ACCESS.md` §3 |

### Hosts (Part 6)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 6.1/6.3 | Host overview and detail | Unit-test verified | `HostsPage.dom.test.tsx`, `HostPage.dom.test.tsx`, `partial-data.dom.test.tsx` |
| 6.2 | Lifecycle: never connected, revoked, source failing, authorization refused | Integration-test verified | D-024 `auth_failed`. `supabase-transport.test.ts` (stubbed fetch), `domain.test.ts`. ✱ Previously a revoked host retried sign-in forever. |
| 6.4 | Multiple hosts, isolation | Integration-test verified (SQL level); Database verified: Blocked | `migrations.test.ts` "host isolation"; `rls.test.ts` not run |

### Claude Code (Parts 7–8)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 7.1 | Provider abstraction | Unit-test verified | `Provider` interface |
| 7.2 | Discovery, version gate, execution boundary, malformed output, interruption, recovery | Integration-test verified (synthetic fixtures; real Node child processes) | D-025. `claude-code.test.ts`, `claude-code-process.test.ts`, `claude-code-version.test.ts`, `claude-code-connector.test.ts` |
| 7.2 | Real CLI behaviour | Blocked (`test:db`, then founder approval) | 11-step checklist in `docs/INTEGRATIONS.md`. Version bounds are placeholders. |
| 7.3 | Privacy: no paths, no raw stderr, generated titles by default | Unit-test verified | D-025. Whether CLI names come from prompts is unverified, so they aren't synced. |
| 7.4 | Health distinctions | Unit-test verified | Failure categories (D-025). The UI still shows one "source not responding" message, because categories don't reach the database (**G27**). |
| 7.5 | Adapter stays disabled until the gates pass | Unit-test verified | `config` test; `cli.ts` provider selection only after an authorized flip |
| 8 | Honest provider capabilities | Unit-test verified | ✱ Fixed this cycle: `domain.test.ts` "claims for Claude Code only what its provider implements" |

### Accounts, data and security (Parts 9, 10, 15)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 9.1/9.3 | Sign-in lifecycle, rejected key, races, tabs, per-project session storage | Integration-test verified | D-020. `auth.dom.test.tsx`, `backend-switch.test.ts` (real supabase-js), `auth-errors.test.ts`, `auth-signout.test.ts`. Real multi-tab: Blocked. |
| 9.2 | Isolation, client side | Unit-test verified | `auth.dom.test.tsx`, `alerts.dom.test.tsx` owner guard |
| 9.2 | Isolation, server side (RLS, forged identity, `owner_uid` fails closed) | Integration-test verified (SQL level); Database verified: Blocked | D-021, D-022. `migrations.test.ts`, `upgrade.test.ts` |
| 10.2 | Persist only what's needed; transcripts off in the cloud | Integration-test verified (SQL level) | D-022 `transcripts_enabled`. ✱ No retention: events grow without limit (a manual purge is in `DEPLOYMENT.md` Operations), and `listSessions` silently caps at 500 (**G28**). |
| 10.3 | Sync: newer wins, dedupe, Realtime as invalidation only | Integration-test verified (SQL level + api-client) | `realtime-subscribe.test.ts` (INSERT/UPDATE only, private channel, join status). Settings → Application shows "Live updates: On / Unavailable (using 30 s refresh)". Real Realtime authorization: unverified. |
| 10.4 | Pre-production database review | Blocked (Docker) | 70 PGlite tests; `rls.test.ts` (31+ cases) never run. Options in `docs/DB_TESTING.md`. |
| 15.1/15.2 | Least privilege, no secrets, safe errors, CSP possible | Unit-test verified | `check-dist` secret rules, `edge-function-pins.test.mjs`, `generate-headers.test.mjs`, `errors.test.ts` |
| 15.3 | Security review | In progress | Independent reviews every cycle. `npm audit`: founder decision. |
| 15.4 | Absolute constraints | Complied | No bypasses; real adapter off; no relay |

### Onboarding, settings, UX, PWA (Parts 11–14)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 11.1 | First launch explains | Unit-test verified | `SetupPage.dom.test.tsx` |
| 11.2 | Setup steps; pairing | Implemented | End to end: Blocked (Docker). ✱ No guided checklist (**G29**). |
| 11.3 | Never claim pairing succeeded; invalid config; schema mismatch | Unit-test verified | `pairing.test.ts`, `HostsPage.dom.test.tsx`, `form-errors.test.ts` |
| 12 | Settings: every control real | Unit-test verified | `SettingsPage.dom.test.tsx`. ✱ No diagnostics section (**G27**). |
| 13.1/13.2 | Design, responsive, mobile | Implemented (code review) | Mobile review on 2026-11-03: 4 High and 10 Medium findings. The self-contained ones are fixed (`mobile.css`, `route-focus.ts`, the copy). Remaining: **G30**. Browser and device: Blocked. |
| 13.3 | Accessibility | Unit-test verified (jsdom axe, no contrast) | `a11y.dom.test.tsx`, `partial-data.dom.test.tsx`. ✱ No axe on AlertsPage or HostPage, and no contrast check (**G31**). |
| 14.1 | Manifest, install guidance | Unit-test verified (static) | `check-dist` manifest checks. Installability: Blocked. |
| 14.2 | Offline behaviour; cached states never shown as live | Integration-test verified | D-019, D-023. `partial-data.dom.test.tsx` page + banner. No offline shell on a cold launch (no service worker, D-011). |
| 14.3 | Device testing | Blocked | — |
| 14.4 | Evaluate Expo only when needed | Implemented (decision) | ✱ Previously mislabelled "phone access". The domain is platform-neutral (G18), and no native need has been shown yet. |

### Reliability (Part 16)
- **Integration-test verified:**
  - CLI failure, missing, timeout, interrupted or incompatible;
  - connector silence, network loss and restart;
  - duplicate and delayed writes;
  - sleep and resume (synthetic clocks);
  - concurrent tabs;
  - session disappearance;
  - host recovery and revocation;
  - auth expiry;
  - account switching;
  - offline, unreachable or paused backend;
  - partial data;
  - notification storms;
  - hung requests (20 s).
- **Remaining:** one malformed row still fails the whole list (`parseRows`), **G28**. A sleep under 90 s can't be told apart from tab throttling.

### Performance (Part 17)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 17 | Lazy routes; bundle budget | Unit-test verified (release gate) | `check:dist`: 227.6 kB gzip in total against a 270 kB budget (2026-11-03). Real-network load: unmeasured. |

### Release (Parts 19–21)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 19 | Production readiness | Not started (gated) | `docs/RELEASE.md` (versioning, environment variables, rollback, reproducible build), `docs/DEPLOYMENT.md` (gates, smoke test, operations). Licence: founder decision. |
| 21 | Completion criteria 1–16 | — | 1, 3, 6, 7 (Alerts page), 8, 9 (client side) and 14 at Unit/Integration level. 2, 10, 11, 12, 13 and 16 partial. 15 Blocked. None is Browser, Device, Database or Security verified. |

## Prioritized gaps (local work)

Done: G1–G21. G13 finished 2026-11-03 (partial data D-023, sleep/resume D-024).

| # | Gap | Size | Notes |
|---|---|---|---|
| G22 | Mark the Disconnected and Source chips as unknown while hosts are missing | S | Spec 3.1 |
| G23 | Keep dashboard filters when going back from a session | S | Spec 3.3; mobile review M1 |
| G24 | Explicit transition model | M | Spec 4.2; lower value |
| G25 | Mark read and dismiss a session's alerts from its page | S | Spec 4.4, 21.7 |
| G26 | Name resolution states on the Alerts page | S | Spec 5.5 |
| G27 | Diagnostics: provider failure categories reach the UI; Settings diagnostics with "copy report" | M | Spec 2 area 10, 7.4, 12. Categories need a DB contract change (a schema bump), so design carefully. |
| G28 | List truncation honesty (500 cap); one malformed row shouldn't fail the list; retention | M | Spec 10.2, 16 |
| G29 | Guided setup checklist | M | Spec 11.2 |
| G30 | Remaining mobile review items: H4b filter disclosure, M2 timeline length, M9/M10 iOS status bar and sticky banner (device check), Low 1/2/8/9/12 | S–M | Spec 13 |
| G31 | Axe on AlertsPage and HostPage; token contrast test | S | Spec 13.3 |
| G32 | QA LOW-3/LOW-4 (bursts across tabs; duplicate paused message); re-check backlog L2/L3/I1/I3 | S | — |

## Founder decisions pending
1. Licence. The public repo has none, so it's all rights reserved.
2. D-013: session names in notifications. This also covers whether to offer the provider's `cli_name` title option (D-025).
3. Whether to run `npm audit`.
4. Phone access, in the order in `docs/PHONE_ACCESS.md` §5: IT clearance (using the corrected data description in `DEPLOYMENT.md` "What leaves the laptop"), a Supabase project, hosting, deployment.
5. How to run `test:db`: options in `docs/DB_TESTING.md`. Recommended: an approved Docker machine (A), then GitHub Actions (B, needs a push). This gates the real adapter, phone access and any production database.
6. A manual browser and device check (with the mobile items flagged in G30).
7. Claude Code hooks (an edit to `~/.claude/settings.json`). Needed to detect approval, completion and failure for real sessions.
8. Background push architecture (M6).
9. Transcript excerpts: confirm D-004 against spec 4.3.
10. BYOS sign-up guidance: create the owner, then disable sign-ups (now in the runbook, step 2.4).
11. Pushing the local commits to the public repo.
12. Whether `npm run connector -- doctor` may run while `REAL_ADAPTER_ENABLED` is false (it runs the real CLI read-only), to help with the before-enabling checklist.
13. Confirm the CSP default: the exact project origin in `connect-src`, with the wildcard only on request (`PHONE_ACCESS.md` §5, decision 5).
