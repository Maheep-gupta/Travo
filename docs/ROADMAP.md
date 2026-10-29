# Tavro roadmap

Owned by the product-manager role. Update this file after every unit of work (see `/tavro-ship`).
Status: ✅ done and verified · 🟡 in progress · ⬜ planned · ⛔ blocked · 🔒 needs user approval.

**Last updated:** 2026-10-30

## Product goal

Users can trust Tavro to tell them what their AI coding sessions are doing and when one needs their attention, on a phone or a desktop, without exposing their data.

## Next task

**M9 and M3 release readiness: dependency and licence review, plus deep-link and refresh documentation.** Acceptance criteria:
- A licence inventory of production dependencies, taken offline from `package-lock.json` and `node_modules`, is recorded in docs/QUALITY.md. Flag any copyleft or unknown licences.
- `npm audit` is run only if the user approves the network call. Otherwise it's recorded as not run.
- Document how to serve `apps/web/dist` with an SPA fallback so deep links like `/sessions/:id` and `/alerts` survive a refresh. Verify locally with `vite preview` on 127.0.0.1 using HTTP requests only; no browser is needed.

After that, the candidates are the M2 per-device "show session names" option and the low-severity alert edge cases.

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
- ⬜ Optional, per device: "show session names in system notifications". Off by default for privacy.
- ✅ The Settings card re-reads the permission state and the failed-to-show flag when the tab is focused or becomes visible.
- ✅ The unread count appears in the tab title ("(2) Tavro") and, where supported, as an app-icon badge through the Badging API. This works even where system notifications don't, such as Android Chrome. Verified by unit tests; badge rendering is unverified because no browser is available.
- ⬜ A session that drops out of the 500-row list and then returns can alert again (rare).
- ⬜ An alert ID can collide if a provider changes status without updating `last_activity_at`. Revisit with the real adapter.
- ⛔ Real-browser check of the permission prompt, notification display, click-to-open and the 4-tab layout: browser automation is blocked.

### M3: Installable PWA 🟡
- ✅ PNG icons (192, 512, maskable 512, apple-touch 180), generated by `scripts/generate-icons.mjs` with no dependencies. Complete manifest (`id`, `scope`, purposes, categories); iOS and Android meta tags.
- ✅ No service worker (D-011).
- ⬜ Deep links and refresh on static hosting, documented.
- ⛔ Install behaviour verified in real browsers: browser automation is blocked, so this needs a manual check by the user.

### M4: Local read-only monitoring ⛔
Blocked by M5. The Claude Code adapter (`claude agents --json`) is designed in docs/INTEGRATIONS.md and stays disabled.

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

- Host credentials in the OS credential store instead of a JSON file (SECURITY gap 2).
- Cleanup Edge Function for revoked host Auth users (SECURITY gap 4).

## Done log

- 2026-10-30: M2 Tavro Alerts, M3 icons and manifest, and the M1 design and accessibility pass. Five specialist agents ran in parallel or in sequence: release, designer, researcher, then QA and security reviewing the combined diff. Their findings were fixed before the commit.
- 2026-10-29: Git baseline (`fc0bcb1`). Team infrastructure: `CLAUDE.md`, `.claude/agents/*`, `/tavro-ship`, and these docs.
