# Quality gates, known limitations and release checklist

## Gates for every commit

| Check | Command | Status on this machine |
|---|---|---|
| Type check (strict, all workspaces and DB tests) | `npm run typecheck` | Available |
| Lint, including the platform-neutrality rules for `@mc/domain` | `npm run lint` | Available |
| Unit and component tests (vitest "unit" in Node, "dom" in jsdom) | `npm test` | Available. 386 tests as of 2026-11-02 (third cycle), including axe accessibility checks (jsdom; no colour contrast). Component tests use jsdom, not a real browser, so layout, CSS and real notification APIs aren't covered. |
| Production web build | `npm run build -w @mc/web` | Available |
| Browser checks (65) | `npm run test:e2e` | **Unavailable.** Endpoint protection kills headless Chrome and Edge. |
| RLS and isolation tests | `npm run test:db` | **Unavailable.** The Docker engine doesn't respond. |

`npm run check` runs the first three. A change to the web app also needs the build to pass.

When reporting results, label each check as **automated** (it ran), **synthetic** (unit-level simulation of browser or platform behaviour), **manual** (a person did it) or **unavailable**.

## Known limitations (user-facing)

- Demo data only. No real Claude sessions are shown yet.
- No phone access: the app binds to `127.0.0.1` and there's no deployment.
- System notifications only work while Tavro is open in a browser tab. There's no background push. They're best-effort: after several minutes in the background a tab is throttled (timers run once a minute), and a frozen or discarded tab can't notify at all.
- Platform limits for system notifications, documented from MDN browser-compat-data and WebKit (accessed 2026-10-30), not tested on devices:
  - Chrome on Android always refuses page notifications without a service worker. Tavro detects this and says so.
  - iOS and iPadOS 16.4 and later only offer notifications inside an app installed to the Home Screen.
  - Safari ignores `tag`, so Tavro removes duplicates itself.
  - Chrome Incognito blocks notifications.
- Alerts are detected by the open app, so changes that happen while Tavro is closed don't produce alerts. They show up as the current status when you reopen it.
- Alert detection pauses while the browser reports being offline or a data fetch has failed. If Tavro's own connection drops silently without a failed fetch, a host can still be reported as disconnected.
- Visual and responsive quality is reviewed from code only. No screenshots can be taken here.
- The host and session lists are polled every 30 s, including in background tabs, so a dropped Realtime channel can't freeze them. That's one extra read per open tab every 30 s against the user's own Supabase project (fine for a handful of sessions; it counts toward Free-plan egress).
- Every Supabase request is aborted after 20 s (`REQUEST_TIMEOUT_MS`), because supabase-js has no timeout of its own. A hung request therefore shows the "can't reach the backend" banner within about 20 s plus the 90 s stale window, rather than never.
- "Updated X ago" is an upper bound when stale: the last good read was no later than the time shown.
- Pairing confirmation only waits while the Hosts page is open, and it's judged against the current time even when the client is offline.

## Serving the production build

`npm run build -w @mc/web` writes static files to `apps/web/dist`. No server code is needed. The host must:

1. **Fall back to `index.html` for app routes** (`/`, `/sessions/:id`, `/alerts`, `/hosts`, `/settings`), so that a deep link or a refresh works.
   - Verified 2026-10-30 with `vite preview` on 127.0.0.1 over HTTP: all of these return 200 with the app shell. The manifest returns `application/manifest+json` and the icons `image/png`.
2. **Return 404 for missing files under `/assets/`, not the HTML shell.** After a redeploy, an old tab may request a chunk that no longer exists.
   - `vite preview` serves the shell with a 200 status in that case. Tavro's page loader turns the failure into a "Couldn't load this page" retry, but a real 404 fails faster and is clearer.
3. **Cache headers:**
   - `/assets/*` (content-hashed): `Cache-Control: public, max-age=31536000, immutable`.
   - `index.html` and `manifest.webmanifest`: `no-cache`.
4. **Serve over HTTPS.** This is required for installation and notifications. Loopback is exempt.
5. **Send the security headers** in `deploy/cloudflare/_headers`.
   - The template is kept out of `apps/web/public` so the build never ships it. It is copied into `dist/` at deploy time (`docs/DEPLOYMENT.md` step 7).
   - CSP starts as `Content-Security-Policy-Report-Only` and becomes enforcing only after a manual browser check (step 10).
   - The template also marks the unhashed `/theme-init.js` as `no-cache`, and adds a `/` rule.

**Release gate for the built files:** `npm run check:dist`, or `npm run check:release`, which runs `check`, then the build, then `check:dist`. The script is `scripts/check-dist.mjs`, with unit tests in `scripts/check-dist.test.mjs`. It fails if:
- `index.html` has an inline script, an inline style, or a `style=` or `on*=` attribute;
- a file references something that isn't in `dist`;
- the manifest or icons are incomplete (installability itself still needs a browser);
- any text file contains a secret-looking value (an `sb_secret_…` value, a JWT or base64 JSON, a service-role key assignment, a private-key block, a Postgres URL with a password) or a local path (`C:\Users`, `/home/…`, `/Users/…`, `file:///`);
- a source map or `sourceMappingURL` ships;
- a service worker is registered (D-011);
- `dist/_headers`, if present, differs from the template;
- the gzip budget is exceeded.

**Bundle budget (G17).** gzip level 9, 1 kB = 1000 B. Set 2026-11-02 at about 20% above the measured build:

| Budget | Limit | Measured 2026-11-02 |
|---|---|---|
| Entry chunk (`index-*.js`) | 86 kB | 70.6 kB |
| Any other chunk or CSS | 70 kB | 56.9 kB (`supabase-entry`, Supabase mode only) |
| All JS + CSS | 270 kB | 220.9 kB |

Raise a budget only deliberately, with a note here. `check:dist` isn't part of `npm run check`, because it needs a fresh build. Run `check:release` before any release.

Deployment itself still needs approval (D-005, D-017). The runbook is `docs/DEPLOYMENT.md`.

## Dependency licences

Production dependencies were inventoried offline from `package-lock.json` on 2026-10-30. There are 24 packages:
- 17 MIT (supabase-js and its sub-packages, TanStack Query, React, React Router and others);
- 1 0BSD (tslib);
- 6 of Tavro's own workspace packages, which have no licence field.

There are no copyleft or unknown third-party licences. Dev-only tools are excluded.

**Open:** the repository has no LICENSE file, so the public GitHub repo is "all rights reserved" by default. Choosing a licence is the owner's decision.

`npm audit` has **not** been run, because it sends the dependency list to the npm registry, and that needs approval.

## Release checklist (M9)

| Area | Requirement | Status |
|---|---|---|
| Functional | Core flows work in demo and Supabase modes | Demo: unit tests only. Supabase: unverified. |
| Security | `test:db` passes, `db:lint` is clean, pairing and revocation work end to end | ⛔ not run |
| Privacy | No transcript or session text in storage, caches, notifications or logs | Reviewed per change |
| Accessibility | Keyboard paths, focus, labels, live regions, reduced motion, contrast in both themes | Code review only |
| Responsive | No overflow at 360/390 px; touch targets of at least 44 px | Code review only (e2e blocked) |
| Performance | Bundle sizes recorded; route-level splitting; automated budget | **Automated** (`check:dist`, 2026-11-02): entry 228 kB raw / 70.6 kB gzip (budget 86); Supabase chunk 221 / 56.9 kB (budget 70 per chunk); all JS + CSS 745 / 220.9 kB (budget 270). Pages lazy-load. Real-network load time unmeasured. |
| PWA | Manifest, icons, installability, update behaviour | Manifest fields, PNG, maskable and apple-touch icons, and the links in `index.html` are **automated** (`check:dist`). Installability, maskable rendering and iOS appearance are **unverified** because no browser is available (`DEPLOYMENT.md` step 9, checks 7–8). No service worker (D-011, enforced by `check:dist`), so there's no update or caching risk. |
| Build hygiene | No inline code (CSP), secrets, local paths, source maps or service worker in `dist` | **Automated** (`check:dist`, 2026-11-02; passes on the current build). Pattern-based, so a secret in an unusual format could slip through. |
| Security headers | CSP, HSTS, `nosniff`, referrer, permissions, COOP, frame denial | Template ready: `deploy/cloudflare/_headers`, with CSP in Report-Only. Not served anywhere. Header delivery, deep-link cache rules and CSP violations are **unverified** until `DEPLOYMENT.md` step 9 (checks 1, 3, 5). |
| Errors and observability | No third-party telemetry. Errors are mapped to safe messages. | Partial |
| Docs | README, BYOS, SECURITY and this file are current | Ongoing |
| Dependencies | Pinned lockfile; licence review | Licences reviewed (all permissive). `npm audit` not run (needs approval). The project's own licence isn't chosen yet. |
| Deployment and rollback | Runbook with authorization gates, post-deploy checks and rollback | Runbook written (`docs/DEPLOYMENT.md`); nothing executed. 🔒 Every provider step needs founder authorization (D-005, D-017). `test:db` targets only the local stack (see runbook step 4). |
