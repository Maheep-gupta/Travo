# Tavro roadmap

Owned by the product-manager role. Update this file after every unit of work (see `/tavro-ship`).
Status: ✅ done and verified · 🟡 in progress · ⬜ planned · ⛔ blocked · 🔒 needs user approval.

**Last updated:** 2026-10-29

## Product goal

Users can trust Tavro to tell them what their AI coding sessions are doing and when one needs their attention, on a phone or a desktop, without exposing their data.

## Next task

**M2 Tavro Alerts (in-app and foreground system notifications).** Acceptance criteria:

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
- ⬜ Design and accessibility review pass: designer agent, code-level only, because screenshots are blocked.
- ⬜ Filter state in the URL survives refresh and back/forward. Verify the current behaviour first.

### M2: Tavro Alerts 🟡 (see Next task)
- ⬜ Optional, per device: "show session names in system notifications". Off by default for privacy.

### M3: Installable PWA ⬜
- ⬜ PNG icons (192, 512, maskable) and apple-touch-icon. Complete the manifest (`id`, `scope`, theme colours for both themes).
- ⬜ Decide whether to add a service worker at all (an ADR is needed). It must never cache API or session data.
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

- 2026-10-29: Git baseline (`fc0bcb1`). Team infrastructure: `CLAUDE.md`, `.claude/agents/*`, `/tavro-ship`, and these docs.
