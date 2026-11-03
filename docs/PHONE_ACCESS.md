# Phone access architecture

**Status:** designed, not deployed. Every provisioning step below needs founder authorization (D-005, D-017).
**Research date:** 2026-11-02, by the researcher role, from official provider documentation. Claims marked *unverified* weren't confirmed from a primary source.

## Goal and constraints

The goal is to open Tavro on a phone, away from the laptop, and see real session state.

Constraints:
- The laptop accepts no inbound traffic. The connector only makes outbound HTTPS calls.
- There is no relay that recreates remote control (D-003, org policy `allow_remote_control: false`).
- The client holds only the Supabase publishable key. Authorization is RLS.
- Transcripts never leave loopback (D-004). Only session metadata is synced.

## Target architecture

```
Laptop (connector, outbound only) ──HTTPS──▶ User's Supabase project (Auth, Postgres + RLS, Edge Function pair-host)
                                                     ▲
Phone / desktop browser ── loads static PWA ─────────┘  (data goes browser ↔ Supabase directly)
        ▲
Static host (Cloudflare, assets only)
```

The static host only serves files. Session data never passes through it.

## 1. Static hosting: recommended Cloudflare (assets only, free tier)

| Host | Verdict | Reason |
|---|---|---|
| **Cloudflare Pages or Workers static assets** | **Recommended** | Static requests are free with no published cap. SPA fallback is built in. A `_headers` file sets CSP, HSTS and cache rules. HTTPS on the default subdomain. No inactivity pause. |
| Netlify Free | Not recommended | Credit-based. Forum reports say sites stay paused after credits run out (*unverified*). |
| Vercel Hobby | Not recommended | Its terms allow only non-commercial, personal use. |
| GitHub Pages | Rejected | No custom headers (so no CSP or HSTS), deep links return a 404 status, and GitHub advises against using it for sign-in flows. |
| Supabase Storage | Rejected | Serves HTML as `text/plain` by design. |

Known limitation: Cloudflare's SPA mode returns the app shell with a 200 status for a missing `/assets/*` chunk. Tavro's page loader already turns that into a retry, so this is accepted.

Privacy: the host logs IP addresses, user agents and paths. Paths like `/sessions/:id` reveal session UUIDs to those logs, but no names or content. Keep Cloudflare Web Analytics off.

## 2. Supabase as the control plane

**Pausing.** Free projects pause after 7 days of low activity. A paused project can be restored for up to a year; Pro projects never pause.
- The connector's heartbeat very probably keeps the project active while the laptop is on (*unverified*).
- A week with the laptop off would pause it.
- Mitigations: an in-app "project unreachable" state, or Pro at $25 a month (a paid decision).

**What a paused project returns (researched 2026-11-03).**
- *Verified (primary source):* Supabase documents HTTP **540** as "project paused: the project cannot process requests until it is un-paused by the owner", and 54x as platform project-state codes ([HTTP status codes](https://supabase.com/docs/guides/troubleshooting/http-status-codes)). A paused project is restored from its dashboard page within a year ([Upgrading](https://supabase.com/docs/guides/platform/upgrading)).
- *Unverified:* whether a 540 response carries CORS headers. Without them a browser can't read the status and sees a plain network error. There's no official statement, and an open request for clearer paused-project errors has no answer ([discussion #38217](https://github.com/orgs/supabase/discussions/38217), Aug 2025). Community reports of half-paused projects show 502, 544 and CORS errors. Not tested against a real paused project.
- *Implemented:* `toApiError` maps 540 to `ApiError` code `paused`, which the banner shows as "Your Supabase project is paused" with restore instructions. A 540 is never retried; the 30 s poll notices the restore. Everything else that means "no usable answer" is `unavailable`: status 0 (network failure, timeout, CORS), 502–504, 520+, PGRST000–003, or a 5xx without a code. The copy for `unavailable` says the project may be paused and how to restore it, so the paused case is still covered if the 540 can't be read.

**Free-plan limits that matter here:**
- 200 concurrent Realtime connections and 2M messages a month.
- 500k Edge Function invocations.
- 1-day log retention.

**Region.** Choose the region nearest the user, or whatever data-residency rules require (an IT question). Assume the region can't be changed later.

**What reaches Supabase** (corrected 2026-11-03; the field-by-field table is in `DEPLOYMENT.md` → *What leaves the laptop*):
- host rows: the name the owner typed when pairing, the platform, the connector version, and last-seen and source-health times;
- session rows: status, a status reason, timestamps, provider, the Claude session id, a title and a project label;
- session events (status transitions).

The title and project label are **not aliased**. In the committed connector (`apps/connector/src/providers/claude-code.ts`, commit `5c5d35f`):
- `title` is the CLI's `name` field from `claude agents --json`, with control characters removed and capped at 300 characters. Claude Code may derive it from the first prompt.
- `project_label` is the raw last segment of the session's working directory, capped at 200 characters. Only roots, drive letters and home directories themselves are suppressed.

**This is changing:** the provider is being reworked in the working tree, with a generated, content-free title by default and the CLI name opt-in. Update this section and the DEPLOYMENT.md table to whatever is actually committed and deployed.

No transcripts reach Supabase.

**Open risk:** titles may carry prompt text and project labels may carry customer or codenames. Resolve both before enabling the real adapter, for example by syncing only a generated label by default and an alias for the project.

**Realtime vs polling:**
- Use Realtime for invalidation only, and always refetch through RLS.
- RLS is not applied to DELETE events, so never subscribe to DELETE. Revocation is already a flag, not a delete.
- Don't subscribe phones to host heartbeat updates. Compute "disconnected" from `last_seen_at` on a timer.
- Mobile browsers drop background WebSockets, so keep a slow fallback poll and refetch when the page becomes visible.
- **As implemented (D-022, migration `20261105000001`):** the app joins a **private** channel `tavro-changes:<random>` and listens to INSERT and UPDATE on `sessions` and `session_events` only. `hosts` is no longer in the `supabase_realtime` publication (the host list is polled), and `session_messages` never was. A SELECT-only policy on `realtime.messages` lets owners, never hosts or anon, join `tavro-changes:*`. With no INSERT policy, nobody can broadcast or track presence there.
- **Realtime "Allow public access" stays OFF** on a hosted project (DEPLOYMENT.md step 2.5). Public channels would let anyone holding the publishable key join any topic. Live updates are meant to keep working with it off; that is *unverified* until provisioning (DEPLOYMENT.md step 9, check 14).

## 3. Background push (M6, not approved)

**Platforms:**
- **iOS/iPadOS 16.4+:** Web Push works only for apps added to the Home Screen, and permission must come from a user gesture. No Apple developer account is needed.
- **iOS 18.4+:** Declarative Web Push works without a service worker.
- **Android Chrome:** Web Push needs a service worker.

**Minimal architecture, with no server of our own:**
1. A push-only service worker. It has `push` and `notificationclick` handlers, no fetch handler, no caching, and a tested kill-switch. This revisits D-011.
2. A VAPID key pair per user project. The private key is an Edge Function secret.
3. A `push_subscriptions` table with owner-only RLS. Endpoints are treated as secrets.
4. A database webhook on `session_events` that calls a `notify` Edge Function. The webhook authenticates with a dedicated random secret held in Vault, never the project secret key: pending pg_net requests are readable by database roles.
5. The `notify` function sends fixed generic text only (D-009, D-013). It deduplicates and deletes dead subscriptions.
6. A server-side detector for disconnected hosts, such as a cron job over `last_seen_at`. This revisits D-008. Whether Cron is available on the Free plan is *unverified*.

Payloads are encrypted end to end, but Apple and Google see timing and endpoint metadata. That is a new external data flow and needs approval.

## 4. Security headers (for `_headers`; start in Report-Only mode)

The source of truth is `deploy/cloudflare/_headers`; `scripts/generate-headers.mjs` writes the deployed copy (DEPLOYMENT.md step 7). Its `/*` block, revised 2026-11-03:

```
/*
  Content-Security-Policy-Report-Only: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; manifest-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'; upgrade-insecure-requests
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  X-Frame-Options: DENY
```

The cache rules (`/assets/*` immutable; `/`, `/index.html`, `/manifest.webmanifest` and `/theme-init.js` no-cache) are in the template.

- **BYOS means the project URL isn't known at build time,** so the template carries the `*.supabase.co` wildcard. At deploy time the generator replaces it with the one project's exact origin (`--project-url`); the wildcard ships only with `--wildcard`, as a recorded decision. With an exact origin, a Supabase custom domain works too. Loopback URLs belong only in dev and preview configs.
- **`worker-src 'none'`:** there is no service worker (D-011). M6 push would have to revisit this.
- **Trusted Types** start in Report-Only, like the rest of the CSP, to find out whether React or supabase-js write to a DOM sink (*unverified*). Browser support outside Chromium is *unverified*. DEPLOYMENT.md step 10 says what to do if they report.
- **Report-Only lasts at most 14 days** after the first deployment (DEPLOYMENT.md step 10, with the reasons).
- **iOS:** the CSP console on an iPhone or iPad can only be read through Safari Web Inspector on a Mac. Without one, iOS CSP behaviour stays *unverified*.
- **Theme script:** done 2026-11-02. It moved to `public/theme-init.js`, a blocking same-origin script, so `script-src 'self'` covers it with no hash (`theme.dom.test.tsx` asserts there is no inline script).
- **React inline `style` props** are set through the CSSOM, so they should be fine under `style-src 'self'`. This needs a manual browser check (*unverified*).
- `frame-ancestors` works only as an HTTP header, not a `<meta>` tag.

## 5. Founder decisions, in order

1. IT or Claude-admin clearance for uploading metadata to a personal Supabase project, including the question of session titles derived from prompts.
2. Authorize creating the Supabase project: the region, and Free vs Pro. Then run `test:db` against it, or locally.
3. Authorize the hosting provider (recommended: Cloudflare), and choose the default subdomain or a custom domain.
4. Approve deployment.
5. Exact project origin in `connect-src` (recommended, the generator's normal mode), or accept the `*.supabase.co` wildcard so one deployment can serve several projects.
6. M6 push: the push-only service worker, server-side detection, VAPID secrets and the push-service metadata flow.
7. Keep D-013 off until the session-title question is answered.

## What can be prepared locally without authorization

- `_headers` file template and its deploy-time generator (`scripts/generate-headers.mjs`).
- A "project unreachable or paused" state.
- Visibility-triggered refetch.
- Deployment runbook.

All of these are tracked in `docs/ROADMAP.md`.
