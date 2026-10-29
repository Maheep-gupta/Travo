# Quality gates, known limitations and release checklist

## Gates for every commit

| Check | Command | Status on this machine |
|---|---|---|
| Type check (strict, all workspaces and DB tests) | `npm run typecheck` | Available |
| Lint, including the platform-neutrality rules for `@mc/domain` | `npm run lint` | Available |
| Unit tests | `npm test` | Available |
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

Deployment itself still needs approval (D-005).

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
| Performance | Bundle sizes recorded; route-level splitting | Baseline 2026-10-30: entry chunk 232 kB raw / 72 kB gzip; Supabase chunk 220 / 57 kB (Supabase mode only); Alerts page 3.6 kB |
| PWA | Manifest, icons, installability, update behaviour | Manifest complete and PNG and maskable icons generated (verified by the build). Installability, maskable rendering and iOS appearance unverified because no browser is available. No service worker (D-011), so there's no update or caching risk. |
| Errors and observability | No third-party telemetry. Errors are mapped to safe messages. | Partial |
| Docs | README, BYOS, SECURITY and this file are current | Ongoing |
| Dependencies | Pinned lockfile; licence review | Licences reviewed (all permissive). `npm audit` not run (needs approval). The project's own licence isn't chosen yet. |
| Deployment and rollback | Not applicable until a deployment is approved | 🔒 |
