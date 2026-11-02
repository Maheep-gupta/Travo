# Tavro gap analysis

**Requirements source:** `docs/PRODUCT_SPEC.md` v1.0.
**Last updated:** 2026-11-02.
**Owner:** the product-manager role. The first pass was done by the product-manager agent from code inspection; the main session then updated statuses after integrating that day's work.
**Test baseline:** `npm test` passes 170 tests (unit and dom, jsdom). `test:db` has never run (Docker is blocked), and neither has `test:e2e` (browser automation is blocked).

**Status labels** (spec Part 19):
- Not started · In progress · Implemented · Automated-test verified · Browser/device verified · Security verified · Production ready
- Blocked (reason) · Needs founder decision

**Rules for using them:**
- "Automated-test verified" requires a named test in `npm test`.
- Nothing is Browser/device verified (browser automation is blocked).
- Nothing DB-related is Security verified (`test:db` has never run).
- Nothing is Production ready.

## Status by area

### Dashboard (Part 3)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 3.1 Grouped overview counts | Automated-test verified | `view-model.test.ts`, "status groups". The spec wants a count per state plus a total → **G6**. |
| 3.1 Sources unavailable reflected | Automated-test verified | `source_unavailable` counts in the Offline/unavailable group (`view-model.test.ts`, "never shows a stale stored status…"). A separate tile → **G6**. |
| 3.1 No misleading aggregates when stale | Automated-test verified | Offline host → disconnected; failing source → source_unavailable |
| 3.2 Card content (title, state, project, host, activity, attention) | Implemented | No component test → **G11** |
| 3.2 Last successful source update on cards | Not started | **G4** |
| 3.2 No absolute paths or home-folder names | Automated-test verified | `claude-code.test.ts`, "projectLabelFromCwd" |
| 3.3 URL filters, invalid values ignored | Automated-test verified | `view-model.test.ts`, "dashboard filter in the URL" |
| 3.3 Per-state, host and project filters | Not started | **G6** |
| 3.4 Attention, then recency | Automated-test verified | `domain.test.ts`, "filtering and ordering" |
| 3.4 Other sort orders; deterministic tie-break | Not started | **G6** (`compareByAttention` has no id tie-break) |
| 3.5 Loading, empty, error states | Implemented | **G11** |
| 3.5 No hosts vs no sessions; offline; auth expired; partial data | Not started | **G10**, **G5**, **G3** |
| 3.5 Demo data never looks real | Automated-test verified | `demo.test.ts`, `api-client.test.ts` |

### Sessions (Part 4)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 4.1 States, with "disconnected" derived | Automated-test verified | `domain.test.ts`, "host connectivity" |
| 4.1 Source not responding, separate from session state | Automated-test verified | `domain.test.ts` (`displayStatus` with `sourceOk`), `view-model.test.ts`, `alerts.test.ts` "session source health" (6 tests), `connector.test.ts` heartbeat `provider_ok`, demo outage test. The v2 migration and RLS cases are Blocked (Docker). |
| 4.1 A failed read never becomes completed or ended | Automated-test verified | `connector.test.ts`, "reports a failing provider separately…" |
| 4.2 No duplicate transitions; reconnect catch-up | Automated-test verified | `connector.test.ts`, `domain.test.ts` `diffObservations` |
| 4.2 No false transitions after sleep (web) | Implemented | Connectivity is judged at fetch time. Needs a test. |
| 4.2 Out-of-order updates (newer wins) | Not started | **G12** |
| 4.3 Detail page basics; untrusted-state explanation | Implemented | `SessionPage.tsx` explains both "disconnected" and "source not responding". **G11**. |
| 4.3 Source health and last update on detail; related alerts | Not started | **G4**, **G7** |
| 4.4 No remote commands | Automated-test verified | `connector.test.ts`, "never grants control capabilities" |

### Alerts (Part 5)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 5.2 Session and host alert kinds | Automated-test verified | `alerts.test.ts`, "detectAlerts" |
| 5.2 Source unavailable / recovered alerts | Automated-test verified | `alerts.test.ts`, "session source health". They reuse the host preferences (decision D-014). |
| 5.3 / 5.4 Identity, dedupe, list cap, tabs, sign-out | Automated-test verified | `alerts.test.ts`, `apps/web/src/alerts.test.ts`, `alerts.dom.test.tsx` |
| 5.4 Switching user A → B without signing out | Not started | Query keys lack the user id → **G2** |
| 5.5 Notification center | Automated-test verified | `alerts.dom.test.tsx`, "AlertsPage" |
| 5.6 System notifications (foreground, opt-in, generic) | Automated-test verified (synthetic) | Real browsers: Blocked |
| 5.6 Session names (D-013) | Needs founder decision | Built and inactive |
| 5.7 Background push, quiet hours | Blocked (M6 architecture, cloud and IT approval) | |

### Hosts (Part 6)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 6.1 Name, connectivity, last seen, platform, version | Implemented | **G11** |
| 6.1 Session count and last activity per host | Not started | **G8** |
| 6.2 Connectivity threshold, never connected, revoked | Automated-test verified | `domain.test.ts` |
| 6.2 Source not responding on the host card | Implemented | `HostsPage.tsx` `.host-warning`. **G11**. |
| 6.3 Host detail page | Not started | **G8** |
| 6.4 Cross-host isolation | Blocked (Docker) | `rls.test.ts` |

### Claude Code (Part 7)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 7.1 Provider abstraction | Automated-test verified | `Provider` interface; `mapClaudeAgentsStatus` tests |
| 7.2 Parsing robustness (synthetic) | Automated-test verified | `claude-code.test.ts` |
| 7.2 Live CLI behaviour | Blocked (Docker, then founder approval) | Checklist in `docs/INTEGRATIONS.md` |
| 7.3 Privacy: paths, error output | Automated-test verified | `claude-code.test.ts`. Whether session names come from prompts is unknown. |
| 7.4 Health distinctions in the connector | Automated-test verified | `connector.test.ts`. The UI shows one generic "source not responding" message. |
| 7.5 Adapter stays disabled | Automated-test verified | `connector.test.ts`, "keeps the real adapter disabled" |

### Accounts, data and security (Parts 9, 10, 15)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 9.1 Sign-in, sign-out, restore | Implemented | No tests → **G3** and **G11** |
| 9.1 Expired auth | Not started | `PGRST301` maps to "not allowed" → **G3** |
| 9.2 Server-side isolation, prefs per owner, forged identity | Blocked (Docker) | `rls.test.ts`, 25 cases including the v2 ones; never run |
| 10.2 Data inventory (what is stored, and why) | Not started | **G10** (Privacy section) |
| 10.4 Migration recovery | Implemented (documented) | `ARCHITECTURE.md`; the transaction behaviour is unverified |
| 15.2 Keys, HTTPS, notification content | Automated-test verified | `api-client.test.ts`, alerts tests |
| 15.2 Safe database error messages | Implemented | The `toApiError` "invalid" branch passes `e.message` through. Review it under **G3**. |
| 15.3 Dependency audit | Needs founder decision (`npm audit` is a network call) | Licences reviewed |

### Onboarding, settings, UX, PWA (Parts 11–14)
| Requirement | Status | Evidence / gap |
|---|---|---|
| 11.1 What Tavro does | Implemented (minimal) | Setup page |
| 11.1 What is collected and stored, and where; what's unavailable | Not started | **G10** |
| 11.2 Pairing flow | Implemented | End to end: Blocked (Docker) |
| 11.3 Verify that the first host connected (never assume success) | Not started | **G10** |
| 11.3 Invalid configuration and schema mismatch | Automated-test verified | `form-errors.test.ts`, `domain.test.ts` "schema compatibility" (v1 rejected, v2 accepted) |
| 12 Notifications settings | Automated-test verified | Alert preferences and system-notification tests |
| 12 Appearance: system / dark / light | Automated-test verified | `theme.test.ts`, `theme.dom.test.tsx` (16 tests). Visual result: Blocked (browser). Follow-up: CSP hash for the inline theme script. |
| 12 Account, Integrations, Privacy, Application sections | Not started | **G10** |
| 13.3 Accessibility, tested | Not started | No axe assertions → **G11** |
| 13.2 / 13.3 Responsive layout and contrast | Implemented (code review) | Blocked (browser) |
| 14.1 Manifest and icons | Implemented | Installing: Blocked (browser) |
| 14.1 Install guidance in the app | Not started | **G10** |
| 14.2 Offline indication | Not started | **G5** |
| 14.3 Device testing | Blocked (browser and device automation; no deployment) | |

### Reliability (Part 16)
Automated-test verified: CLI failure, connector silence, connector network loss, duplicates, concurrent tabs, session disappearance, host recovery, app refresh.
Implemented without a test: web network loss (pauses detection), sleep (fetch-time judgement), database unavailable (ErrorState).
Not started: auth expired (**G3**), out-of-order updates (**G12**), account switching (**G2**), collapsing notification bursts.

## Prioritized gaps

| # | Gap | Depends on | Parallel-safe with |
|---|---|---|---|
| G1 | Source not responding | — | **Done 2026-11-02** (database cases unrun) |
| G9 | Source alerts | G1 | **Done 2026-11-02** |
| G2 | Account-switch isolation: user id in every user-data query key; clear on any user change; dom test switching A → B | — | Sequence with G3 and G5 (all touch the `App.tsx` shell) |
| G3 | Expired auth: map `PGRST301`/401 to `unauthorized`, then sign-in with a notice; unit and dom tests; review the `invalid` message pass-through | — | Same as G2 |
| G11 | Component and accessibility tests (Dashboard, SessionCard, SessionPage, Hosts, Setup, Sign-in) plus `vitest-axe` | — | Everything (new test files only) |
| G4 | Visible freshness: "Updated Xm ago", separate from activity; stale marker | G1 ✓ | G8 |
| G5 | Offline banner: "Offline, showing data from HH:MM" | — | after G2/G3 (shell) |
| G6 | Counts, filters and sorting to spec, with an id tie-break | G1 ✓ | G8, G11 |
| G7 | Session ↔ alerts link, plus filter by host or provider from a session | — | G6 |
| G8 | Host detail `/hosts/:id`, with session count and last activity | G1 ✓ | G6 |
| G10 | Onboarding verification; Settings Account, Privacy, Application and Integrations | Appearance ✓ | G6 |
| G12 | Stale-write guard (newer wins) in a v3 migration; database cases unrun | G1 ✓ | anything outside `supabase/` |

## Founder decisions pending
1. Licence (the public repo has none, so it's all rights reserved).
2. D-013: session names in notifications.
3. Whether to run `npm audit`.
4. Deployment and hosting for phone access. Without it, the core value proposition (spec 1.4) can't be met.
5. Fixing Docker, or another way to run `test:db`. Enabling the real adapter then needs separate approval.
6. A manual or alternative browser and device check.
7. Claude Code hooks (an edit to `~/.claude/settings.json`).
8. Background push architecture (M6).
9. Transcript excerpts: confirm D-004 (loopback-only "Recent messages") against spec 4.3, or hide that card for real providers.
10. Open sign-ups in BYOS projects: confirm the guidance to disable them after creating the owner account.
