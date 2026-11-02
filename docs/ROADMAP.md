# Tavro roadmap

Owned by the product-manager role. Update this file after every unit of work (see `/tavro-ship`).
Status: ✅ done and verified · 🟡 in progress · ⬜ planned · ⛔ blocked · 🔒 needs user approval.

**Last updated:** 2026-11-02

## Product goal

Users can trust Tavro to tell them what their AI coding sessions are doing and when one needs their attention, on a phone or a desktop, without exposing their data.

## Next task

The requirements source is `docs/PRODUCT_SPEC.md`. Status for every requirement is in `docs/GAP_ANALYSIS.md`; the gap numbers (G#) below refer to it.

**Next cycle** (G numbers are in GAP_ANALYSIS; session continuity is in `docs/EXECUTION_STATE.md`):
1. **G13, reliability edges.** A request timeout for hung fetches: supabase-js has none, so a hung request currently hides the offline banner. Partial-data presentation when one query fails. A sleep/resume test.
2. **G19, phone-access local preparation.** A `_headers` template, a deployment runbook, a "project paused or unreachable" state and refetch when the page becomes visible. Deployment itself needs authorization (`docs/PHONE_ACCESS.md`).
3. **G14** unread alerts on the dashboard; **G15** text search.
4. **G16** collapsing notification bursts; **G17** bundle budget; **G18** moving pure web logic into `@mc/domain`.
5. **G20** auth backlog M2, L1, L3.

**Done 2026-11-02 (third cycle):** G4 (visible freshness), G5 (offline banner), G7 (session ↔ alerts), G10 (Settings Account, Privacy & data, Integrations and Application sections; Setup onboarding; pairing confirmation) and G12 (schema v3 stale-write guard, D-015). The theme script moved to a file so a strict CSP is possible. Phone-access architecture is in `docs/PHONE_ACCESS.md`.
- Fixes from the QA and security reviews:
  - freshness is capped by the client's own fetch time, and the banner and cards agree;
  - persistent skipped or failing writes report the source as not responding;
  - the v3 conflict-key grants;
  - accurate privacy copy.
- The database cases are written but not run.

**Done 2026-11-02 (second cycle):** G2, G3, G6, G8 and G11, plus fixes for the defects the new tests found. 250 tests pass.

**Done 2026-11-02: G1 and G9, session source health (schema v2, D-014).**
- `hosts.provider_error_since` is written only by the heartbeat.
- The connector reports health immediately when it changes.
- The new display state "Source not responding" replaces any stale stored status.
- Source-unavailable and source-recovered alerts.
- The host card and session page explain the state; the demo simulates an outage.

Verified by unit and dom tests (170 total). The RLS cases (v2 heartbeat, no direct writes, cross-owner) are written but **not run** (Docker).

Deviations from the planned acceptance criteria, both recorded in D-014:
- Clients require v2 instead of also accepting v1, because no project ever applied v1.
- The state is a dedicated "Source not responding" rather than "unknown", because the spec lists it as its own state.

**Done 2026-11-02:** the Appearance setting (System / Dark / Light), with no flash of the wrong theme, 16 tests, and colour values unchanged. Follow-up: allow the inline theme script by its hash when a CSP is added.

**Waiting on the user** (no work can proceed without them):
- Choose a project licence.
- Approve or decline `npm audit` (it's a network call).
- Approve a push of the local commits.
- Deployment and hosting for phone access (the core promise in spec 1.4 can't be met without it). See GAP_ANALYSIS for the full founder-decision list.
- **Approve or reject D-013**, the session names in system notifications. The code is built and inactive behind `SESSION_NAMES_OPTION_APPROVED = false`.
- Fix Docker, or approve a browser for testing, to unblock M4/M5 and visual QA.

---

**Done 2026-10-30: M2 Tavro Alerts.** The original acceptance criteria are kept below for reference.

1. Pure `detectAlerts` in `@mc/domain`:
   - The first snapshot is a baseline and produces no alerts.
   - It produces alerts only when a session's stored status changes into approval_required, waiting_for_input, failed or completed, observed while its host is online.
   - It produces host disconnected and reconnected alerts.
   - A session behind an offline host is never alerted on. Its last trusted status is kept, so a reconnect with an unchanged status produces no alert.
   - Each alert has a deterministic ID, so duplicates are dropped.
   - Alerts are filtered by `NotificationPrefs`.
2. The in-app Alerts page:
   - Lists alerts newest first, with an unread count in the top bar and links to the session.
   - Mark read, mark all read, dismiss and clear all.
   - It's capped at 50 alerts and persisted per backend and user.
   - Storage holds only IDs, kinds and timestamps (no titles or transcript text).
3. System notifications:
   - Permission is requested only from an explicit button in Settings.
   - Unsupported, default, denied, granted and failed-to-show states are all handled and explained.
   - There's a per-device on/off switch.
   - A notification fires only while Tavro is open in a background tab.
   - The body is generic and contains no session text.
   - The copy states that it's foreground-only and that there's no background push.
4. Tests cover baseline, duplicates, transitions, the offline host, reconnect, preferences, the store cap and dedupe, and the permission-state mapping.

**Must not change:** the security baseline; the existing routes; the preferences schema.

## Milestones

### M0: Foundation and continuity ✅
- ✅ Tavro rebrand (UI, README, manifest). The `@mc/*` package scope is kept by decision D-007.
- ✅ Lazy page loading with retry (`apps/web/src/page-loading.tsx`).
- ✅ Git baseline, team agents, `/tavro-ship`, roadmap, decisions and quality docs.
- ✅ Leftover "Mission Control" comment removed from the schema migration (the migration has never been applied).

### M1: Excellent core dashboard 🟡
- ✅ Attention-first sorting, status groups, search and filters, session detail with history, host connectivity, and loading, empty and error states (built before this roadmap; verified by unit tests only).
- ✅ Design and accessibility pass (designer agent, from code only, with no screenshots):
  - light-theme contrast raised to AA;
  - overflow fixed at 360/390 px;
  - stronger input focus;
  - 44 px touch targets on coarse pointers;
  - loading announcements;
  - heading order;
  - copy that implied replies were supported, corrected.
- ✅ Filters already lived in the URL. They're now validated (unknown and prototype-named values are ignored, and search is capped at 200 characters). Group and integration toggles are history steps, and the live region is always mounted. Verified by 5 unit tests.
- ✅ Setup and Sign-in field errors are linked to their inputs (`aria-invalid` and `aria-describedby`), and focus moves to the first invalid field. Setup now shows every invalid field, not just the first. Verified by unit tests for the issue-to-field mapping, including the privileged-key rejection.

### M2: Tavro Alerts ✅ (foreground only)
- ✅ `detectAlerts`, `mergeAlerts`, `parseStoredAlerts` and `alertNotificationText` in `@mc/domain`, plus the Alerts page, the unread badge in the navigation, the Settings card for system notifications, and storage synced across tabs. Verified by typecheck, lint, 83 unit tests and the build. The browser and the e2e checks weren't run (blocked).
- ✅ QA review fixes:
  - no false host alerts from stale data;
  - the cache is cleared when the user switches;
  - no alerts after a host that was offline at baseline reconnects;
  - tabs no longer overwrite each other;
  - a full list no longer drops new alerts;
  - detection pauses when preferences fail to load.
- ✅ Security review fixes:
  - alerts are cleared on sign-out and backend change;
  - notification tags no longer identify sessions;
  - stored IDs are validated strictly.
- 🔒 Session names in system notifications (D-013). It's built, security-reviewed and fixed: scoped per user, off by default, withdrawn when notifications are turned off, with control and bidi characters stripped. It stays **inactive until the user approves**.
- ✅ Component tests (jsdom and Testing Library, 12 tests) cover:
  - the watcher: baseline, a single alert with no duplicates, pausing on a preferences or hosts error without losing the change, and clearing on sign-out;
  - the Alerts page: order, links, mark read, clear-all confirmation, dismiss and the empty state;
  - the navigation badge label and the tab title.
  They run in `npm test`.
- ✅ The Settings card re-reads the permission state and the failed-to-show flag when the tab is focused or becomes visible.
- ✅ The unread count appears in the tab title ("(2) Tavro") and, where supported, as an app-icon badge through the Badging API. This works even where system notifications don't, such as Android Chrome. Verified by unit tests; badge rendering is unverified because no browser is available.
- ⬜ A session that drops out of the 500-row list and then returns can alert again (rare).
- ⬜ An alert ID can collide if a provider changes status without updating `last_activity_at`. Revisit with the real adapter.
- ⛔ Real-browser check of the permission prompt, notification display, click-to-open and the 4-tab layout: browser automation is blocked.

### M3: Installable PWA 🟡
- ✅ PNG icons (192, 512, maskable 512, apple-touch 180), generated by `scripts/generate-icons.mjs` with no dependencies. Complete manifest (`id`, `scope`, purposes, categories); iOS and Android meta tags.
- ✅ No service worker (D-011).
- ✅ Deep links and refresh on static hosting, documented in docs/QUALITY.md, "Serving the production build". Verified over HTTP against `vite preview` on loopback.
- ⛔ Install behaviour verified in real browsers: browser automation is blocked, so this needs a manual check by the user.

### M4: Local read-only monitoring ⛔ (groundwork 🟡)
- ✅ `ClaudeCodeProvider` and `parseClaudeAgentsJson` are built and disabled. They have 34 tests on synthetic output; see docs/INTEGRATIONS.md for behaviour and the list of things to verify live.
- ✅ The connector has a provider-error state, separate from offline, with tests.
- ⬜ Show the provider error in the UI, with schema v2 (see Next task).

Enabling it is blocked by M5. The Claude Code adapter (`claude agents --json`) is designed in docs/INTEGRATIONS.md and stays disabled.

### M5: Security and backend verification ⛔
Blocked: the Docker engine doesn't respond. Checklist: docs/SECURITY.md, "Before enabling real Claude Code data".

### M6: Phone notifications while Tavro is inactive 🔒
Needs Web Push or Expo push infrastructure, so it needs an approved architecture and probably cloud and IT clearance. Research can be done; building can't start yet.

### M7: Native mobile app (Expo) ⬜
Starts after M3–M5. It reuses `@mc/contracts`, `@mc/domain` (including `detectAlerts`) and `@mc/api-client`.

### M8: Multi-provider support ⬜
Only Claude Code has a supported read path (docs/FEASIBILITY.md). The other providers are link-out only.

### M9: Production readiness ⬜
See the release checklist in docs/QUALITY.md.

## Blocked / needs approval

| Item | Blocker | Unblocks |
|---|---|---|
| `npm run test:db`, pairing end to end, real adapter | Docker engine unresponsive | M4, M5 |
| `npm run test:e2e`, screenshots, install verification | Endpoint protection kills automated Chrome and Edge | Visual QA, M3 verification |
| Claude Code hooks (approval, failure events) | Needs approval to edit `~/.claude/settings.json` | Better status accuracy |
| Background push | Architecture, cloud and IT approval | M6 |

## Backlog (unscheduled)

- From the auth security review (2026-11-02):
  - **M2:** keeping alert history after an expired sign-in is best-effort. With two tabs open, or when auth-js fails a refresh, the history is cleared, which errs on the safe side. Also, A's alert metadata stays in storage if B signs in after A's session expires. Fix: remember the last user id and clear on a different user.
  - **L1:** a gateway 401 for a rotated publishable key also looks like an expired sign-in.
  - **L3:** no tests yet for a slow getUser racing an auth event, for multiple tabs, or for alerts kept on expiry.

- Host credentials in the OS credential store instead of a JSON file (SECURITY gap 2).
- Cleanup Edge Function for revoked host Auth users (SECURITY gap 4).

## Done log

- 2026-10-30: M2 Tavro Alerts, M3 icons and manifest, and the M1 design and accessibility pass. Five specialist agents ran in parallel or in sequence: release, designer, researcher, then QA and security reviewing the combined diff. Their findings were fixed before the commit.
- 2026-10-29: Git baseline (`fc0bcb1`). Team infrastructure: `CLAUDE.md`, `.claude/agents/*`, `/tavro-ship`, and these docs.
