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

**Free-plan limits that matter here:**
- 200 concurrent Realtime connections and 2M messages a month.
- 500k Edge Function invocations.
- 1-day log retention.

**Region.** Choose the region nearest the user, or whatever data-residency rules require (an IT question). Assume the region can't be changed later.

**What reaches Supabase:**
- host rows (name, last seen, source health);
- session rows (status, timestamps, title, provider, aliased project label);
- session events.

No transcripts reach Supabase.

**Open risk:** real Claude Code session titles may be derived from prompt text. Resolve this before enabling the real adapter, for example by syncing only a generated label by default.

**Realtime vs polling:**
- Use Realtime for invalidation only, and always refetch through RLS.
- RLS is not applied to DELETE events, so never subscribe to DELETE. Revocation is already a flag, not a delete.
- Don't subscribe phones to host heartbeat updates. Compute "disconnected" from `last_seen_at` on a timer.
- Mobile browsers drop background WebSockets, so keep a slow fallback poll and refetch when the page becomes visible.

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

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/index.html
  Cache-Control: no-cache
/manifest.webmanifest
  Cache-Control: no-cache
```

- **BYOS means the project URL isn't known at build time.** Hence the `*.supabase.co` wildcard, which means Supabase custom domains are unsupported. Loopback URLs belong only in dev and preview configs.
- **Theme script:** done 2026-11-02. It moved to `public/theme-init.js`, a blocking same-origin script, so `script-src 'self'` covers it with no hash (`theme.dom.test.tsx` asserts there is no inline script).
- **React inline `style` props** are set through the CSSOM, so they should be fine under `style-src 'self'`. This needs a manual browser check (*unverified*).
- `frame-ancestors` works only as an HTTP header, not a `<meta>` tag.

## 5. Founder decisions, in order

1. IT or Claude-admin clearance for uploading metadata to a personal Supabase project, including the question of session titles derived from prompts.
2. Authorize creating the Supabase project: the region, and Free vs Pro. Then run `test:db` against it, or locally.
3. Authorize the hosting provider (recommended: Cloudflare), and choose the default subdomain or a custom domain.
4. Approve deployment.
5. Accept the `*.supabase.co` wildcard, and with it "custom domains unsupported".
6. M6 push: the push-only service worker, server-side detection, VAPID secrets and the push-service metadata flow.
7. Keep D-013 off until the session-title question is answered.

## What can be prepared locally without authorization

- `_headers` file template.
- A "project unreachable or paused" state.
- Visibility-triggered refetch.
- Deployment runbook.

All of these are tracked in `docs/ROADMAP.md`.
