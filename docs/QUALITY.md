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
- System notifications only work while Tavro is open in a browser tab. There's no background push. On iOS, notifications need the app installed to the Home Screen; this is unverified.
- Alerts are detected by the open app, so changes that happen while Tavro is closed don't produce alerts. They show up as the current status when you reopen it.
- Visual and responsive quality is reviewed from code only. No screenshots can be taken here.

## Release checklist (M9)

| Area | Requirement | Status |
|---|---|---|
| Functional | Core flows work in demo and Supabase modes | Demo: unit tests only. Supabase: unverified. |
| Security | `test:db` passes, `db:lint` is clean, pairing and revocation work end to end | ⛔ not run |
| Privacy | No transcript or session text in storage, caches, notifications or logs | Reviewed per change |
| Accessibility | Keyboard paths, focus, labels, live regions, reduced motion, contrast in both themes | Code review only |
| Responsive | No overflow at 360/390 px; touch targets of at least 44 px | Code review only (e2e blocked) |
| Performance | Bundle sizes recorded; route-level splitting | Partial |
| PWA | Manifest, icons, installability, update behaviour | ⬜ M3 |
| Errors and observability | No third-party telemetry. Errors are mapped to safe messages. | Partial |
| Docs | README, BYOS, SECURITY and this file are current | Ongoing |
| Dependencies | Pinned lockfile; licence review | ⬜ |
| Deployment and rollback | Not applicable until a deployment is approved | 🔒 |
