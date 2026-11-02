# Tavro gap analysis (requirements traceability matrix)

**Requirements source:** `docs/PRODUCT_SPEC.md` v1.0. Requirement IDs are the spec section numbers (D-016).
**Last updated:** 2026-11-02, third cycle.
**Owner:** product-manager role; statuses updated by the main session after integrating each cycle.
**Test baseline:** `npm test` passes 386 tests (unit and dom/jsdom, including axe checks without colour contrast). `test:db` has never run (Docker is blocked), and neither has `test:e2e` (browser automation is blocked).

**Status labels** (spec Part 19):
- Not started · In progress · Implemented · Automated-test verified · Browser/device verified · Security verified · Production ready
- Blocked (reason) · Needs founder decision

**Rules:**
- "Automated-test verified" requires a named test in `npm test`.
- Nothing is Browser/device verified, because browser automation is blocked.
- Nothing database-related is Security verified, because `test:db` has never run.
- Nothing is Production ready.
- Verification for anything marked Blocked or Not started: the item's own tests, plus a browser/device pass once one is possible.

## Status by area

### Dashboard (Part 3)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 3.1 | Count per state plus a total; sources unavailable shown; no misleading aggregates when stale | Automated-test verified | `view-model.test.ts`, `DashboardPage.dom.test.tsx` |
| 3.2 | Card content: title, state, project, host, activity, attention | Automated-test verified | `DashboardPage.dom.test.tsx` |
| 3.2 | Last successful source update on cards, separate from activity, with a stale marker | Automated-test verified | `freshness.test.ts`, `DashboardPage.dom.test.tsx`. Capped by the client's own fetch time (QA H1 fix). |
| 3.2 | No absolute paths or home-folder names | Automated-test verified | `claude-code.test.ts` "projectLabelFromCwd" |
| 3.3 | Filters by state, host, project and provider in the URL; invalid values ignored | Automated-test verified | `view-model.test.ts`, `DashboardPage.dom.test.tsx` |
| 3.3 | Text search (title, project) in the URL | Automated-test verified | `domain.test.ts` search, `view-model.test.ts`, `DashboardPage.dom.test.tsx` |
| 3.4 | Attention, then recency; six sort orders; deterministic tie-break | Automated-test verified | `domain.test.ts` "filtering and ordering" |
| 3.5 | Loading, empty, error states | Automated-test verified | page dom tests, `components.dom.test.tsx` |
| 3.5 | Offline; auth expired | Automated-test verified | `offline-banner.dom.test.tsx`, `connectivity.test.ts`, `auth.dom.test.tsx` |
| 3.5 | No hosts vs no sessions; partial data (one query failing) | Implemented | Empty states differ; partial-data presentation is untested → **G13** |
| 3.5 | Unread alerts on the dashboard | Automated-test verified | `DashboardPage.dom.test.tsx`, `view-model.test.ts` `unreadBySession` |
| 3.5 | Demo data never looks real | Automated-test verified | `demo.test.ts`, `api-client.test.ts` |

### Sessions (Part 4)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 4.1 | States, with "disconnected" derived | Automated-test verified | `domain.test.ts` "host connectivity" |
| 4.1 | Source not responding, separate from session state | Automated-test verified | `domain.test.ts`, `alerts.test.ts`, `connector.test.ts`. The v2 database cases are Blocked (Docker). |
| 4.1 | A failed read never becomes completed or ended | Automated-test verified | `connector.test.ts` "reports a failing provider separately…" |
| 4.2 | No duplicate transitions; catching up after a reconnect | Automated-test verified | `connector.test.ts`, `domain.test.ts` `diffObservations` |
| 4.2 | No false transitions after sleep (web) | Implemented | Connectivity is judged at fetch time. Needs a dedicated test (**G13**). |
| 4.2 | Out-of-order updates: newer wins | Automated-test verified (synthetic); database Blocked (Docker) | Schema v3 (D-015). `connector.test.ts` (overlapping connectors, skipped "ended" retry, skip → source not responding), memory transport guard tests, demo clock step-back. The `rls.test.ts` "stale-write guard" cases have not run. |
| 4.3 | Detail basics; explanation of untrusted states | Automated-test verified | `SessionPage.dom.test.tsx` |
| 4.3 | Source health and last update on the detail page | Automated-test verified | `SessionPage.dom.test.tsx` |
| 4.3 | Related alerts; links to the same host or provider | Automated-test verified | `SessionPage.dom.test.tsx`, `view-model.test.ts` `sessionAlerts` |
| 4.3 | Transcript excerpts (spec) vs D-004 | Needs founder decision | Founder decision 9 |
| 4.4 | No remote commands | Automated-test verified | `connector.test.ts` "never grants control capabilities" |

### Alerts (Part 5)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 5.2 | Session, host and source alert kinds | Automated-test verified | `alerts.test.ts` |
| 5.3/5.4 | Identity, dedupe, list cap, tabs, sign-out, account switch | Automated-test verified | `alerts.test.ts`, `apps/web/src/alerts.test.ts`, `alerts.dom.test.tsx`, `auth.dom.test.tsx` |
| 5.5 | Notification center | Automated-test verified | `alerts.dom.test.tsx` "AlertsPage" |
| 5.6 | System notifications (foreground, opt-in, generic text) | Automated-test verified (synthetic) | Real browsers: Blocked |
| 5.6 | Session names in notifications (D-013) | Needs founder decision | Built and inactive |
| 5.7 | Collapse notification bursts | Not started | **G16** |
| 5.7 | Background push, quiet hours | Blocked (M6 architecture, cloud and IT approval) | Design in `docs/PHONE_ACCESS.md` §3 |

### Hosts (Part 6)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 6.1 | Name, connectivity, last seen, platform, version, session count, last activity, last update | Automated-test verified | `HostsPage.dom.test.tsx`, `HostPage.dom.test.tsx` |
| 6.2 | Connectivity threshold, never connected, revoked, source not responding | Automated-test verified | `domain.test.ts`, `HostPage.dom.test.tsx` |
| 6.3 | Host detail page | Automated-test verified | `HostPage.dom.test.tsx` |
| 6.4 | Cross-host isolation | Blocked (Docker) | `rls.test.ts`, which now includes a cross-host upsert case |

### Claude Code (Part 7)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 7.1 | Provider abstraction | Automated-test verified | `Provider` interface; `mapClaudeAgentsStatus` tests |
| 7.2 | Parsing robustness (synthetic fixtures) | Automated-test verified | `claude-code.test.ts` |
| 7.2 | Live CLI behaviour | Blocked (Docker, then founder approval) | Checklist in `docs/INTEGRATIONS.md` |
| 7.3 | Privacy: paths, error output | Automated-test verified | `claude-code.test.ts`. Whether session titles come from prompts is unknown (D-013 risk). |
| 7.4 | Health distinctions | Automated-test verified | `connector.test.ts`. The UI shows one generic "source not responding" message. |
| 7.5 | Adapter stays disabled | Automated-test verified | `connector.test.ts` "keeps the real adapter disabled" |

### Accounts, data and security (Parts 9, 10, 15)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 9.1 | Sign-in, sign-out, restore, expired sign-in | Automated-test verified | `auth.dom.test.tsx`, `SignInPage.dom.test.tsx`, `errors.test.ts` |
| 9.2 | Isolation in the client (cache keys, alerts, account switch) | Automated-test verified | `auth.dom.test.tsx` |
| 9.2 | Isolation on the server (RLS, prefs per owner, forged identity) | Blocked (Docker) | `rls.test.ts`, never run |
| 10.2 | Data inventory: what is stored, where, and why | Automated-test verified | Settings "Privacy & data" and Setup "Before you start" (`SettingsPage.dom.test.tsx`, `SetupPage.dom.test.tsx`). Claims checked against code by the security review. |
| 10.4 | Migration recovery | Implemented (documented) | `ARCHITECTURE.md`; transaction behaviour unverified |
| 15.2 | Keys, HTTPS, notification content, safe error messages | Automated-test verified | `api-client.test.ts`, `errors.test.ts`, `components.dom.test.tsx`, alerts tests |
| 15.2 | Strict CSP possible (no inline script) | Automated-test verified | `theme.dom.test.tsx`. The header itself ships at deployment (`docs/PHONE_ACCESS.md` §4). |
| 15.3 | Dependency audit | Needs founder decision (`npm audit` is a network call) | Licences reviewed |

### Onboarding, settings, UX, PWA (Parts 11–14)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 11.1 | What Tavro does, collects and can't do; demo mode | Automated-test verified | `SetupPage.dom.test.tsx` |
| 11.2 | Pairing flow | Implemented | End to end: Blocked (Docker) |
| 11.3 | Confirm that the first host connected (never assume success) | Automated-test verified | `HostsPage.dom.test.tsx`, `view-model.test.ts` `pairingStatus` |
| 11.3 | Invalid configuration and schema mismatch | Automated-test verified | `form-errors.test.ts`, `domain.test.ts` "schema compatibility" (v2 rejected, v3 accepted) |
| 12 | Account, Alerts, System notifications, Appearance, Privacy & data, Integrations, Application | Automated-test verified | `SettingsPage.dom.test.tsx`, `theme.*`, system-notification tests. There are no dead controls: Integrations and Application only show information. |
| 13.3 | Accessibility checks | Automated-test verified (jsdom axe, no contrast) | `a11y.dom.test.tsx` |
| 13.2/13.3 | Responsive layout, contrast | Implemented (code review) | Blocked (browser) |
| 14.1 | Manifest, icons, install guidance in the app | Automated-test verified | `SettingsPage.dom.test.tsx` "Application". Installing: Blocked (browser). |
| 14.2 | Offline indication; cached states never shown as live | Automated-test verified | `offline-banner.dom.test.tsx`, `connectivity.test.ts`, freshness tests |
| 14.3 | Device testing | Blocked (no deployment, no browser automation) | |
| 14.4 | Phone access | Needs founder decision | Architecture in `docs/PHONE_ACCESS.md`; provisioning needs authorization |

### Reliability (Part 16)
- **Automated-test verified:** CLI failure, connector silence, connector network loss, duplicates, concurrent tabs, session disappearance, host recovery, app refresh, auth expired, account switching, web offline, out-of-order writes (synthetic), writes skipped or failing while the heartbeat works.
- **Implemented without a test:** sleep (judged at fetch time), database unavailable (ErrorState).
- **Automated-test verified:** hung requests are aborted after 20 s (`request-timeout.test.ts`).
- **Not started:** collapsing notification bursts (**G16**).

### Performance (Part 17)
| ID | Requirement | Status | Evidence / remaining |
|---|---|---|---|
| 17 | Lazy routes; bundle budget | Automated-test verified (release gate) | `npm run check:release` → `scripts/check-dist.mjs` budgets (entry 86 kB, other chunks 70 kB, total 270 kB gzip; measured 70.6, 56.9 and 221.1). Not part of the per-commit `npm run check`. |

## Prioritized gaps

Done: G1–G12 (G1, G2, G3, G6, G8, G9 and G11 in cycles 1–2; G4, G5, G7, G10 and G12 on 2026-11-02 in cycle 3, with fixes for the QA and security review findings).

| # | Gap | Depends on | Notes |
|---|---|---|---|
| G13 | Reliability edges: ~~request timeout~~ (done 2026-11-02: `withRequestTimeout`, `request-timeout.test.ts`); partial-data presentation; sleep/resume test | — | Spec 3.5, 16 |
| G14 | Unread alerts on the dashboard | — | **Done 2026-11-02** |
| G15 | Dashboard text search | — | **Done 2026-11-02** |
| G16 | Collapse notification bursts | — | Spec 5.7, 16 |
| G17 | Bundle budget and build hygiene | — | **Done 2026-11-02** (`check:release`) |
| G18 | Move pure web logic (`pairingStatus`, `connectivity.ts`) into `@mc/domain` for Expo reuse | — | Maintainability |
| G19 | Phone-access local preparation | — | **Done 2026-11-02:** `deploy/cloudflare/_headers` (CSP report-only), `docs/DEPLOYMENT.md` runbook, `check:dist`. Still open: a "project paused" message. Deployment itself needs authorization. |
| G20 | Auth backlog M2, L1, L3 (from the 2026-11-02 security review) | — | See ROADMAP backlog |

## Founder decisions pending
1. Licence. The public repo has none, so it's all rights reserved.
2. D-013: session names in notifications.
3. Whether to run `npm audit`.
4. Phone access (spec 1.4), in the order given in `docs/PHONE_ACCESS.md` §5: IT clearance, a Supabase project, hosting, deployment.
5. Fixing Docker, or another way to run `test:db`. Enabling the real adapter then needs separate approval.
6. A manual browser and device check.
7. Claude Code hooks (an edit to `~/.claude/settings.json`).
8. Background push architecture (M6).
9. Transcript excerpts: confirm D-004 against spec 4.3.
10. Open sign-ups in BYOS projects: confirm the guidance to disable them after creating the owner account.
11. Pushing the local commits to the public repo.
12. How to run `test:db` before a deployment: on a machine where Docker works (recommended), or against a throwaway hosted project, which needs a helpers change that isn't written (`docs/DEPLOYMENT.md` step 4).
