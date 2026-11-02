# Deployment runbook (prepared, not executed)

**Status:** nothing here has been run. No Supabase project, Cloudflare account or deployment exists. Written 2026-11-02 from `docs/PHONE_ACCESS.md`, `docs/BYOS.md` and the repository; provider steps are from those documents' research, not from a live run, so screen names may differ.

**Who runs it:** the founder, by hand. An agent may run only the steps marked **[local]**.

| Marker | Meaning |
|---|---|
| **[AUTH]** | Needs explicit founder authorization before it is done (D-005, D-017). Record the authorization in `docs/DECISIONS.md`. |
| **[local]** | Runs on the laptop, offline, with no external effect. Allowed under standing authority. |
| **[manual]** | A person checks something in a real browser or device. Automated browsers are blocked on this laptop. |

Architecture recap: the static host serves files only; the browser talks to the user's own Supabase project directly; the connector makes outbound HTTPS calls only. See `docs/PHONE_ACCESS.md`.

## Must stay off in the first deployment

Check each one before step 8, and again after.

- **Real Claude Code adapter:** `REAL_ADAPTER_ENABLED = false` in `apps/connector/src/config.ts`. It stays off until `test:db` passes **and** the open question about session titles derived from prompts is answered (PHONE_ACCESS §2).
- **Session names in notifications (D-013):** `SESSION_NAMES_OPTION_APPROVED = false` in `apps/web/src/system-notifications.ts`.
- **Background push and service workers (D-011, M6):** none. `check:dist` fails if a service worker is registered.
- **Remote control, replies or a command channel:** none (D-003, org policy `allow_remote_control: false`).
- **Cloudflare Web Analytics:** off (PHONE_ACCESS §1).
- **Privileged keys in the client:** only the publishable key is ever entered in the app. `check:dist` scans for secret-looking values.

## 0. Preconditions [local]

```bash
npm ci                     # from the lockfile; no new dependencies
npm run check:release      # typecheck + lint + unit tests + production build + check:dist
```

`check:release` must pass. Also confirm `npm run test:db` has passed on a machine where Docker works (see step 4). It is currently blocked on this laptop.

## 1. IT and Claude-admin clearance [AUTH]

Get written clearance to upload **session metadata** to a personal Supabase project: host names, session status, timestamps, titles, provider and aliased project labels. No transcripts are uploaded.

Raise the session-title question explicitly: real Claude Code titles may be derived from prompt text (D-004, D-013). Without clearance, stop here.

## 2. Create the Supabase project [AUTH]

1. **Account and plan.**
   - Free: $0. Pauses after about 7 days of low activity, and has no backups.
   - Pro: $25 a month, a paid decision. Never pauses, and has backups.
   - The founder chooses.
2. **Region.** Pick the one nearest the user, or whatever IT's data-residency rules require. Assume it can't be changed later.
3. **Database password.** Store it in a password manager. It is never needed by the app and must never be committed or pasted into the app.
4. **Auth settings** (Dashboard → Authentication):
   - Email/password sign-in on. Tavro uses `signInWithPassword`.
   - **Create the owner account first**, with a strong password.
   - **Then disable new sign-ups.** Otherwise anyone who finds the project URL can create an account. RLS still isolates them, but this closes the door.
   - Keep anonymous sign-ins off.
   - JWT expiry: 900 s, as in `supabase/config.toml`. Short tokens bound how long Realtime keeps a revoked grant.
   - Site URL and redirect URLs: set them to the Cloudflare URL once it is known (step 8). Remove any `localhost` and `127.0.0.1` entries.
5. **Realtime:** turn **off** "Allow public access", so only private, RLS-checked channels work (BYOS §7).
6. Copy the **project URL** and the **publishable key** (`sb_publishable_…`). Never copy the secret key anywhere outside the Supabase dashboard.

## 3. Apply the migrations [AUTH]

This uses the Supabase CLI that is already a dev dependency, so nothing new is installed. It does make network calls to Supabase.

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push --dry-run     # review the list: supabase/migrations/*.sql only
npx supabase db push
```

- Review the SQL in `supabase/migrations/` before pushing. That review is the approval step (BYOS §6).
- Afterwards, `public.app_meta.schema_version` must equal `MAX_SCHEMA_VERSION` in `packages/contracts/src/constants.ts` (currently 3). If it doesn't, the app shows its "project needs migration" screen.
- Run `npm run db:lint` locally beforehand. It needs the local stack.
- **Rollback:** a fresh project has no data, so deleting and recreating it is the simplest rollback. Later migrations need `npx supabase db dump` first (no backups on Free).

## 4. RLS and isolation tests (`test:db`)

`npm run test:db` reads keys from the **local** stack (`supabase status`) and creates test users with the admin API. As written, it **cannot** target a hosted project. Pointing it at production would also leave test users there.

- **Recommended [local]:** run `npm run db:start && npm run db:reset && npm run test:db` on a machine where Docker works, at the same commit you deploy. The migrations are identical, so this verifies the policies.
- **Alternative [AUTH]:** a throwaway second project (Free allows 2) with a test-only env loader. That needs a code change, which isn't written.

Until `test:db` has passed somewhere, the release checklist's Security row stays ⛔ and the real adapter stays off.

## 5. Deploy the `pair-host` Edge Function [AUTH]

```bash
npx supabase functions deploy pair-host --no-verify-jwt
```

- `--no-verify-jwt` matches `[functions.pair-host] verify_jwt = false` in `supabase/config.toml`. The connector calls the function before it has a login, so the one-time pairing code is the credential.
- The function reads `SUPABASE_URL` and `SUPABASE_SECRET_KEYS`, which the platform injects. **No `supabase secrets set` is needed.** Never put the secret key in a file.
- In the Dashboard, confirm that JWT verification is off for this function only.
- **Rollback:** `npx supabase functions delete pair-host`. Pairing stops; already-paired hosts keep working.

## 6. Build and verify [local]

```bash
npm run check:release
```

This builds `apps/web/dist` and runs `scripts/check-dist.mjs`. It fails on:
- inline scripts, styles or handlers;
- secret-looking values or local paths;
- source maps or a service worker;
- a missing manifest or icons;
- bundle sizes over budget (see `docs/QUALITY.md`).

Save the output: it records the chunk sizes of what you're about to ship.

## 7. Stage the headers file [local]

`_headers` is deliberately **not** in `apps/web/public`, so a normal build never ships it. Copy it in after building:

```bash
# Git Bash / macOS / Linux
cp deploy/cloudflare/_headers apps/web/dist/_headers
```

```powershell
# PowerShell
Copy-Item deploy/cloudflare/_headers apps/web/dist/_headers
```

Then run `npm run check:dist` again. It should report `_headers present; CSP mode: report-only` and confirm the copy matches the template.

The first deployment ships CSP as **`Content-Security-Policy-Report-Only`**. Every other header (HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, `X-Frame-Options`) is enforced from the start.

A rebuild empties `dist/`, so repeat this step after every build.

## 8. Deploy to Cloudflare (static assets only) [AUTH]

1. Create a Cloudflare account and choose the default `*.pages.dev` subdomain or a custom domain. A custom domain costs money and needs DNS; the founder chooses.
2. Create a **Pages** project with **Direct Upload** and upload the contents of `apps/web/dist`, including `_headers`.
   - Don't connect the Git integration. It would build on Cloudflare from the public repo, so the shipped files would no longer be the ones `check:dist` verified.
   - Don't use `npx wrangler`. Wrangler isn't a project dependency, and `npx` would download it. Adding it needs approval.
3. **No `404.html`** at the top of `dist/` (the build doesn't create one). Cloudflare then serves `index.html` for unknown paths: that's the SPA fallback.
4. Leave Web Analytics off. Add no Workers, Functions, KV or other bindings.
5. Put the final URL into Supabase Auth's Site URL and redirect URLs (step 2.4).

## 9. Post-deploy checks [manual]

Use a real phone and a desktop browser with DevTools. Record each result in `docs/QUALITY.md` as **manual**, with the date and device.

| # | Check | Pass when |
|---|---|---|
| 1 | HTTPS and headers | `curl -I https://<site>/` shows every header from `_headers`, and HSTS. `http://` redirects to `https://`. |
| 2 | Deep links and SPA fallback | Opening and refreshing `/sessions/<id>`, `/alerts`, `/hosts`, `/settings` returns 200 with the app. |
| 3 | Cache rules | `curl -I` on `/assets/<file>.js` shows `immutable`. `/`, a deep link and `/manifest.webmanifest` show `no-cache`. Whether the `/` rule covers fallback responses is unverified, so check it here. |
| 4 | Missing chunk | `/assets/does-not-exist.js` returns the shell with a 200 status. That's the known limitation (PHONE_ACCESS §1); the app shows its "Couldn't load this page" retry. |
| 5 | CSP Report-Only | DevTools console shows **no** CSP violations across Demo mode and Supabase mode: sign-in, Realtime updates, every route, light and dark theme, pairing a host. The only expected note is that `upgrade-insecure-requests` is ignored in report-only mode. In particular, confirm React `style` props are not reported (PHONE_ACCESS §4, unverified). |
| 6 | Supabase connection | Enter the URL and publishable key, sign in as the owner, and see hosts and sessions. A secret key is refused by the app. |
| 7 | Install on Android | Chrome menu → Install app (or Add to Home screen). The icon, name, standalone window and maskable icon look right. |
| 8 | Install on iOS/iPadOS | Safari → Share → Add to Home Screen. The apple-touch icon, title and status bar look right. |
| 9 | Notification permission | Asking happens only after a user gesture. On Android Chrome without a service worker, Tavro explains that page notifications are unavailable. On iOS 16.4+, they're offered only in the Home Screen app. Notification text is generic (D-009). |
| 10 | Offline banner | Airplane mode shows the offline banner and pauses alert detection. Reconnecting recovers. |
| 11 | Paused or unreachable project | With a wrong URL, the app shows the "can't reach the backend" state within about 20 s plus the stale window. |
| 12 | Privacy spot-check | DevTools → Application: local storage holds no transcript or session text. There's no service worker and no Cache Storage. |

## 10. Switch CSP to enforcing [AUTH]

Do this only when check 5 is clean in both modes.

1. In `deploy/cloudflare/_headers`, rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Keep the value unchanged.
2. Commit the change, then repeat steps 6 to 9.
3. `check:dist` should now report `CSP mode: enforcing`. Check 5 should still show no violations, and the app should work.

## 11. Rollback

- **Bad web release:** in Cloudflare Pages → Deployments, roll back to the previous deployment. This is instant and static, and no data is involved. Old tabs that request removed chunks get the retry screen.
- **CSP breaks the app after step 10:** roll back the deployment, or redeploy with Report-Only.
- **Stop serving entirely:** delete the Pages project or its custom domain. Session data lives in Supabase, not on the host.
- **Supabase:** see steps 3 and 5. To revoke a laptop, revoke its host in the app. Pausing or deleting the project stops all syncing.
- **Suspected key leak:** rotate the publishable key in the Dashboard, which only affects identification. If the secret key or database password leaked, rotate them at once. The client never holds either.

## Afterwards

- Update `docs/QUALITY.md`: change release-checklist rows from unverified to manual or verified only for checks that actually ran.
- Record each authorization and the deployment URL's visibility decision in `docs/DECISIONS.md`.
