# Deployment runbook (prepared, not executed)

**Status:** nothing here has been run. No Supabase project, Cloudflare account or deployment exists. Written 2026-11-02 from `docs/PHONE_ACCESS.md`, `docs/BYOS.md` and the repository. Revised 2026-11-03 after a security review of the runbook (findings M1–M8, S1, S7–S11). Provider steps come from those documents' research, not from a live run, so screen names may differ. Anything marked *unverified* has to be checked during provisioning.

**Who runs it:** the founder, by hand. An agent may run only the steps marked **[local]**.

| Marker | Meaning |
|---|---|
| **[AUTH]** | Needs explicit founder authorization before it is done (D-005, D-017). Record the authorization in `docs/DECISIONS.md`. |
| **[GATE]** | Must not start until the **test:db gate** below holds. No exceptions, and no "we'll run it afterwards". |
| **[local]** | Runs on the laptop, offline, with no external effect. Allowed under standing authority. |
| **[manual]** | A person checks something in a real browser or device. Automated browsers are blocked on this laptop. |

Architecture recap: the static host serves files only; the browser talks to the user's own Supabase project directly; the connector makes outbound HTTPS calls only. See `docs/PHONE_ACCESS.md`. Versioning, environment variables and the build procedure are in `docs/RELEASE.md`.

## The test:db gate

Steps 3 (apply migrations), 5 (deploy functions), 8 (publish) and 10 (enforce CSP) are **[GATE]** steps. Before each one, all of the following must be true:

1. `npm run test:db` ran against a real local Supabase stack (`docs/DB_TESTING.md`, option A, B or C) **at the exact commit being deployed**, and passed. A pass at an earlier commit doesn't count, even if "only docs changed": re-run it.
2. The result is recorded in `docs/QUALITY.md` with the date, the machine or CI run, the CLI version, the **full commit SHA** and the output.
3. The working tree is clean, and `git rev-parse HEAD` equals that SHA. Check with `git status --short` (no output) and `git rev-parse HEAD`.

The PGlite layer (`npm run test:sql`) never satisfies this gate (D-021). If the gate doesn't hold, stop.

## Must stay off in the first deployment

Check each one before step 8, and again after.

- **Real Claude Code adapter:** `REAL_ADAPTER_ENABLED = false` in `apps/connector/src/config.ts`. It stays off until `test:db` passes **and** the session-title and project-label questions below are answered (PHONE_ACCESS §2).
- **Session names in notifications (D-013):** `SESSION_NAMES_OPTION_APPROVED = false` in `apps/web/src/system-notifications.ts`.
- **Background push and service workers (D-011, M6):** none. `check:dist` fails if a service worker is registered, and the CSP sets `worker-src 'none'`.
- **Remote control, replies or a command channel:** none (D-003, org policy `allow_remote_control: false`).
- **Cloudflare Web Analytics:** off (PHONE_ACCESS §1).
- **Privileged keys in the client:** only the publishable key is ever entered in the app. `check:dist` scans for secret-looking values.

## What leaves the laptop

This is what the connector sends **today**, read from the committed code (`apps/connector/src/connector.ts`, `apps/connector/src/providers/claude-code.ts`, `packages/domain/src/status.ts` at commit `5c5d35f`, plus the 2026-11-03 review fixes to `status_reason` and `project_label`). It is what IT is asked to clear in step 1.

> **Changing:** another engineer is reworking the Claude Code provider in the working tree. The uncommitted version defaults titles to a content-free generated label and makes the CLI name opt-in. Re-read this section against the code that is actually deployed, and update it, before step 1 and again before enabling the real adapter.

With the **mock provider** (the only one enabled): simulated sessions, all flagged `is_demo`. Nothing about real work is sent.

With the **Claude Code provider** (disabled by `REAL_ADAPTER_ENABLED = false`):

| Table | Field | What it actually contains |
|---|---|---|
| `hosts` | `name` | Whatever the owner typed when creating the pairing code in the app. Not read from the machine. |
| | `platform`, `connector_version` | `process.platform` (e.g. `win32`) and the connector's version (`0.1.0`). |
| | heartbeat and source-health times, `remote_control_allowed` | Timestamps and two booleans. |
| `sessions` | `title` | **The CLI's `name` field from `claude agents --json`, verbatim** apart from control characters being replaced and the length capped at 300. Claude Code may derive this name from the session's first prompt, so it can carry prompt text off the laptop. |
| | `project_label` | **The raw last segment of the session's working directory** (e.g. `C:\work\acme-payments-api` sends `acme-payments-api`), capped at 200 characters. It is not hashed or aliased. Only roots, drive letters, home directories themselves (`C:\Users\<name>`, `/home/<name>`, `/root`) and a segment equal to the local account name (e.g. `D:\Profiles\<name>`, compared case-insensitively) are suppressed, so the account name isn't sent. A folder named after a customer or an internal codename is sent as is. |
| | `external_id` | Claude Code's session id. |
| | `status`, `status_reason` | A mapped status and a fixed sentence. A status the mapping doesn't recognise becomes `unknown` with the fixed text "Unrecognised status from the provider."; the raw value is never sent. |
| | times, `provider`, `capabilities`, `is_demo` | Timestamps, `claude-code`, read-only capability names, `false`. |
| `session_events` | `type`, `status`, `summary`, `dedupe_key`, `occurred_at` | Status transitions. `summary` is empty for Claude Code, or `Session closed`. |
| `session_messages` | transcript excerpts | **Never sent to a hosted project.** Written only when `MC_SYNC_TRANSCRIPTS=true` and the backend URL is a loopback address. Migration `20261105000001` also makes the database refuse them unless `app_meta.transcripts_enabled` is set, which only the local seed does. |

Not sent: prompts or transcripts, full paths, file contents, the machine's hostname, usernames, or Claude credentials (`~/.claude/sessions/*.key` is never read).

## 0. Preconditions [local]

```bash
npm ci                     # from the lockfile; no new dependencies
npm run check:release      # typecheck + lint + unit tests + production build + check:dist
git status --short         # must print nothing
git rev-parse HEAD         # the commit you are deploying; the test:db gate refers to it
```

`check:release` must pass. Then establish the test:db gate (above) for this SHA. It is currently blocked on this laptop (Docker), so in practice it runs on another machine or in CI.

## 1. IT and Claude-admin clearance [AUTH]

Get written clearance to upload **session metadata** to a personal Supabase project, using the table in **What leaves the laptop**. State it exactly as it is: the project label is the raw folder name, not an alias, and the title may come from prompt text. No transcripts are uploaded.

Raise the session-title and project-label questions explicitly (D-004, D-013). Without clearance, stop here.

## 1b. Secure the provider accounts [manual]

Before step 2, and before any Cloudflare work in step 8:

- **Turn on MFA** for the Supabase account and the Cloudflare account. Use an authenticator app or a hardware key, not SMS. Store the recovery codes in the password manager.
- Use a unique password for each account, from the password manager.
- The Supabase organization and the Cloudflare account have no other members.
- Record in `docs/QUALITY.md` (as **manual**, with the date) that MFA is on for both. Neither account is used until it is.

Whoever holds either account can replace the app or read the data, so this is a precondition, not a hardening step.

## 2. Create the Supabase project [AUTH]

1. **Account and plan.**
   - Free: $0. Pauses after about 7 days of low activity, and has no backups.
   - Pro: $25 a month, a paid decision. Never pauses, and has backups.
   - The founder chooses.
2. **Region.** Pick the one nearest the user, or whatever IT's data-residency rules require. Assume it can't be changed later.
3. **Database password.** Generate it in the password manager and store it there. It is never needed by the app and must never be committed or pasted into the app.
4. **Auth settings** (Dashboard → Authentication; screen names *unverified*):
   - Email/password sign-in on. Tavro uses `signInWithPassword`.
   - **Create the owner** with Dashboard → Authentication → Users → **Add user → Create new user**, with **Auto Confirm User** ticked. Use a password-manager password of 20 or more characters. Creating the owner here means no confirmation email is ever needed, and the public sign-up endpoint never has to be open.
   - **Then disable new sign-ups** ("Allow new users to sign up" off). Otherwise anyone who finds the project URL can create an account. RLS still isolates them, but this closes the door. Confirm afterwards that a sign-up attempt is refused (step 9b).
   - **Minimum password length: 12 or more.** It's 12 in `supabase/config.toml`, so local tests run with the same rule.
   - **Secure password change: on.** A password change then needs a recent sign-in. It's on in `supabase/config.toml` too.
   - **Leaked-password protection** (checks against HaveIBeenPwned): turn it on if the plan offers it. It has been a paid-plan feature (*unverified* for the current plans). If it's unavailable, record that in `docs/QUALITY.md`.
   - Keep anonymous sign-ins and manual linking off.
   - JWT expiry: 900 s, as in `supabase/config.toml`. Short tokens bound how long Realtime keeps a revoked grant. Keep refresh-token rotation on.
   - Site URL and redirect URLs: set them to the Cloudflare URL once it is known (step 8). Remove any `localhost` and `127.0.0.1` entries.
   - **Lost or stolen phone:** sign in on another device and use **Sign out** in Settings. Sign out calls auth-js `signOut()` with its default **global** scope, which revokes every refresh token of the owner, on every device. The lost phone keeps a valid access token for at most the JWT expiry (15 minutes), then can't refresh. Then change the owner password. *Verify after provisioning* (step 9b): a second signed-in browser must be signed out within about 15 minutes. Known gap: auth-js reports a 401 from `/logout` as success (EXECUTION_STATE follow-ups), so if the app says Sign out worked but the other device stays signed in, sign the user out from Dashboard → Authentication → Users → owner (whether that option exists on the current Dashboard is *unverified*), or change the password and wait out the 15 minutes.
5. **Realtime:** turn **off** "Allow public access", so only private, RLS-checked channels work (BYOS §7, D-022). The app needs nothing public. It joins a private channel `tavro-changes:<random>`, which a SELECT-only policy on `realtime.messages` opens to owners only, and it listens to INSERT and UPDATE on `sessions` and `session_events`. `hosts` isn't in the Realtime publication (the host list is polled). Check 14 in step 9 confirms live updates still arrive with public access off.
6. Copy the **project URL** and the **publishable key** (`sb_publishable_…`). Never copy the secret key anywhere outside the Supabase dashboard.

## 3. Apply the migrations [AUTH] [GATE]

Check the test:db gate first.

### Where to run the CLI

`npx supabase login` stores a **personal access token that can manage every project and organization on the account**, not just this one. Don't leave one on the corporate laptop. In order of preference:

1. **Run steps 3 and 5 from a non-corporate machine** that has Node 24, a clone of the repository at the deployed SHA, and `npm ci`.
2. **Use the Dashboard instead of the CLI.** In the SQL editor, run each file in `supabase/migrations/` in filename order, one at a time, each exactly as committed. **Never run `supabase/seed.sql`** on a hosted project: it is for the local stack only (it turns on local-only settings such as transcript storage). The drawback is that the CLI's migration history (`supabase_migrations.schema_migrations`) isn't written, so a later `db push` would try to re-apply everything. Pick one method per project and stick to it.
3. **If the CLI must run on the corporate laptop:** run `npx supabase logout` straight after step 5, then delete the token in Dashboard → Account → Access Tokens (a CLI login creates one there). Whether `logout` also revokes the token on the server is *unverified*, so do both. `supabase link` also writes the project ref into `supabase/.temp/`, which is git-ignored. Delete it afterwards as well.

### Commands (CLI route)

This uses the Supabase CLI that is already a dev dependency, so nothing new is installed. It does make network calls to Supabase.

```bash
npx supabase login
npx supabase link --project-ref <project-ref>   # asks for the database password; don't put it in a file
npx supabase db push --dry-run     # review the list: supabase/migrations/*.sql only
npx supabase db push               # NEVER add --include-seed
```

- **Never use `supabase db push --include-seed`, and never run `supabase/seed.sql` on a hosted project, by any route.** In particular:
  - **Never run `supabase db reset --linked`** (or `db reset` with `--db-url` pointing at the hosted project). It drops the remote database, re-applies the migrations **and runs the seed**, because `[db.seed] enabled = true` in `supabase/config.toml` (needed for the local stack). It also deletes all data. `supabase db reset` without those flags only touches the local stack and is fine.
  - **Never enable Supabase Branching or the Supabase GitHub integration** for this project. Preview branches are hosted databases that the platform builds from `supabase/migrations/` **and seeds from `[db.seed]`** (*unverified* for the current platform, so assume it does), so every branch would accept transcripts. The repository is public, so a GitHub integration would also act on any pushed branch. Neither is needed: there is one project and it is deployed by hand.
  - `config.toml` keeps `[db.seed] enabled = true`: turning it off would break the local stack (`npm run test:db` checks that the seeded stack accepts transcripts). Nothing in `config.toml` reliably scopes seeding to the local stack, so these rules are the control. The seed sets `app_meta.transcripts_enabled = true` for the local stack. On a hosted project that would let paired hosts upload transcript excerpts, against D-004 ("transcripts only to a loopback database"). Migration `20261105000001` makes the database refuse transcripts unless that flag is set, and no API role can change it, so the seed is the only thing that could switch it on (D-022). After pushing, confirm it is off: `select transcripts_enabled from public.app_meta;` must return `false`. Step 9b repeats this check.
- Review the SQL in `supabase/migrations/` before pushing. That review is the approval step (BYOS §6).
- Afterwards, `public.app_meta.schema_version` must equal `MAX_SCHEMA_VERSION` in `packages/contracts/src/constants.ts` (currently 4). If it doesn't, the app shows its "project needs migration" screen.
- **Upgrading an existing project from v3 to v4** (D-026): push the migration, then deploy the web app and update each connector. Until a connector is updated it keeps heartbeating (the new argument defaults to null), and its source failures show a generic message instead of the specific cause. A web app older than v4 refuses the upgraded project with "Update the app". **Apply migration `20261112000001_provider_error_kind.sql` before upgrading any connector.** A v4 connector can't heartbeat to a v3 project: PostgREST answers PGRST202 (no `host_heartbeat` with `p_provider_error_kind`), so the host would show as Disconnected. The connector logs `backend out of date: this project needs schema v4: apply the pending migrations (PGRST202)` and retries every few minutes; once the migration is in, it reconnects on its own.
- Run `npm run db:lint` locally beforehand. It needs the local stack.
- **Rollback:** a fresh project has no data, so deleting and recreating it is the simplest rollback. Later migrations need a dump first (no backups on Free; see Operations).

## 3b. Harden the project [AUTH]

Do this straight after the first push, and repeat the checks after every later push. Settings outside `supabase/migrations/` aren't versioned, so record each one in `docs/QUALITY.md`.

- **GraphQL:** Tavro doesn't use it. Disable the `pg_graphql` extension (Dashboard → Database → Extensions), and remove `graphql_public` from the exposed schemas. Grants already deny `anon`, but an unused API is attack surface.
- **Exposed schemas** (Dashboard → API settings, *unverified* screen name): `public` only. Don't expose `storage` or any other schema. Tavro uses no Storage buckets.
- **SSL enforcement:** turn on "Enforce SSL on incoming connections" for direct Postgres connections.
- **Network restrictions:** restrict direct database connections to the IP you run the CLI from, or to none when you aren't migrating. They don't affect the HTTPS API that the app and connector use. Availability on Free is *unverified*.
- **Advisors:** run Dashboard → Advisors → Security Advisor and Performance Advisor, or `npx supabase db lint --linked` (CLI route; it needs a login, see step 3). Fix or explain every error and warning before step 8, and record the result in `docs/QUALITY.md`.
- **Realtime public access** off (step 2.5), and **sign-ups** off (step 2.4): recheck both here.

## 4. RLS and isolation tests (`test:db`)

`npm run test:db` reads keys from the **local** stack (`supabase status`) and creates test users with the admin API. As written, it **cannot** target a hosted project. Pointing it at production would also leave test users there.

- **Recommended [local]:** run `npm run db:start && npm run db:reset && npm run test:db` on a machine where Docker works, at the same commit you deploy. The migrations are identical, so this verifies the policies. This is what the test:db gate records.
- **Alternative [AUTH]:** a throwaway second project (Free allows 2) with a test-only env loader. That needs a code change, which isn't written.

Until `test:db` has passed somewhere, the release checklist's Security row stays ⛔ and the real adapter stays off. After provisioning, the hosted project gets its own smoke test (step 9b).

## 5. Deploy the `pair-host` Edge Function [AUTH] [GATE]

Check the test:db gate first. Same machine and token rules as step 3.

```bash
npx supabase functions deploy pair-host --no-verify-jwt
```

- `--no-verify-jwt` matches `[functions.pair-host] verify_jwt = false` in `supabase/config.toml`. The connector calls the function before it has a login, so the one-time pairing code is the credential.
- The function reads `SUPABASE_URL` and `SUPABASE_SECRET_KEYS`, which the platform injects. **No `supabase secrets set` is needed.** Never put the secret key in a file.
- In the Dashboard, confirm that JWT verification is off for this function only.
- **Dependency pin:** the function imports `npm:@supabase/supabase-js@2.118.0`, the exact version in `package-lock.json`. `scripts/edge-function-pins.test.mjs` (part of `npm test`) fails if the two drift apart. The pin covers supabase-js and its own `@supabase/*` packages, which it pins exactly. It doesn't cover *their* dependencies, which Deno resolves at bundle time.
- **Lockfile (not yet generated):** there is no `deno.lock` for the function. Generating one needs Deno and network access, neither of which is available on this laptop. On a non-corporate machine with Deno 2:
  ```bash
  cd supabase/functions/pair-host
  deno cache --lock=deno.lock index.ts   # resolves and records every npm package with its integrity hash
  ```
  Commit `deno.lock`, then re-run `test:db` (the local Edge runtime serves the function) before relying on it. Whether `supabase functions deploy` honours a function's `deno.lock` is *unverified*: check the deploy output, or the provider's docs at that time.
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

The production build starts the Setup page's Project URL field **empty**. Only dev builds suggest the local stack (`http://127.0.0.1:54321`).

## 7. Generate the headers file [local]

`_headers` is deliberately **not** in `apps/web/public`, so a normal build never ships it. Generate it into `dist/` after building, with the project's **exact** origin in `connect-src`:

```bash
node scripts/generate-headers.mjs --project-url https://<project-ref>.supabase.co
```

- The generator copies `deploy/cloudflare/_headers`, replaces the `https://*.supabase.co wss://*.supabase.co` wildcard with `https://<ref>.supabase.co wss://<ref>.supabase.co`, and adds a marker comment naming the origin. It refuses anything other than a bare public `https://` origin: no path, port, credentials, IP address, loopback name or wildcard.
- **Wildcard only when asked:** `--wildcard` ships the template unchanged, which allows any `*.supabase.co` project. Use it only if the founder decides one deployment must serve several projects (PHONE_ACCESS §5, decision 5), and record that decision. Neither flag is a default; the script refuses to run without one.
- With an exact origin, the deployed app can only talk to that project once CSP is enforcing (step 10). **Change backend** to a different project would then be blocked by the browser. Regenerate and redeploy if the project changes.
- An exact origin also makes a Supabase custom domain possible: pass it as `--project-url`.

Then run `npm run check:dist` again. It should report `_headers present; CSP mode: report-only; connect-src: project https://<ref>.supabase.co`, and confirm the file is exactly what the generator would produce from the template.

The first deployment ships CSP as **`Content-Security-Policy-Report-Only`**. Every other header (HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` including `browsing-topics=()`, COOP, CORP `same-origin`, `X-Frame-Options`) is enforced from the start.

A rebuild empties `dist/`, so repeat this step after every build.

## 8. Deploy to Cloudflare (static assets only) [AUTH] [GATE]

Check the test:db gate first, and that MFA is on (step 1b).

1. Create a Cloudflare account and choose the default `*.pages.dev` subdomain or a custom domain. A custom domain costs money and needs DNS; the founder chooses.
2. Create a **Pages** project with **Direct Upload** and upload the contents of `apps/web/dist`, including `_headers`.
   - Don't connect the Git integration. It would build on Cloudflare from the public repo, so the shipped files would no longer be the ones `check:dist` verified.
   - Don't use `npx wrangler`. Wrangler isn't a project dependency, and `npx` would download it. Adding it needs approval.
3. **No `404.html`** at the top of `dist/` (the build doesn't create one). Cloudflare then serves `index.html` for unknown paths: that's the SPA fallback.
4. Leave Web Analytics off. Add no Workers, Functions, KV or other bindings.
5. Put the final URL into Supabase Auth's Site URL and redirect URLs (step 2.4).
6. **Delete old deployments once this release is verified** (steps 9 and 9b pass). Keep the current deployment and **one** previous one for rollback (step 11), and delete the rest, including preview deployments. Pages keeps each deployment reachable at its own `<hash>.<project>.pages.dev` URL. An old build stays public there with its old code and old headers, even after a fix or a CSP change. *Unverified:* that this is still Cloudflare's behaviour for Direct Upload projects, and whether deleting a deployment is immediate. Check both in the dashboard.

## 9. Post-deploy checks [manual]

Use a real phone and a desktop browser with DevTools. Record each result in `docs/QUALITY.md` as **manual**, with the date and device.

| # | Check | Pass when |
|---|---|---|
| 1 | HTTPS and headers | `curl -I https://<site>/` shows every header from `_headers`, and HSTS. `http://` redirects to `https://`. |
| 2 | Deep links and SPA fallback | Opening and refreshing `/sessions/<id>`, `/alerts`, `/hosts`, `/settings` returns 200 with the app. |
| 3 | Cache rules | `curl -I` on `/assets/<file>.js` shows `immutable`. `/`, a deep link and `/manifest.webmanifest` show `no-cache`. Whether the `/` rule covers fallback responses is unverified, so check it here. |
| 4 | Missing chunk | `/assets/does-not-exist.js` returns the shell with a 200 status. That's the known limitation (PHONE_ACCESS §1); the app shows its "Couldn't load this page" retry. |
| 5 | CSP Report-Only | DevTools console shows **no** CSP violations across Demo mode and Supabase mode: sign-in, Realtime updates, every route, light and dark theme, pairing a host. The only expected note is that `upgrade-insecure-requests` is ignored in report-only mode. In particular, confirm React `style` props are not reported (PHONE_ACCESS §4, unverified), and note any **Trusted Types** reports separately (`require-trusted-types-for`). Check in a Chromium browser and in Firefox. |
| 6 | Supabase connection | Enter the URL and publishable key, sign in as the owner, and see hosts and sessions. Then try two **fabricated** privileged keys, never the real secret key (step 2.6). Generate them in a terminal: `node -e "console.log('sb_secret_'+require('node:crypto').randomBytes(15).toString('base64url'))"` (`sb_secret_` plus 20 random characters), and `node -e "const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');console.log(b({alg:'none',typ:'JWT'})+'.'+b({role:'service_role'})+'.')"` (an unsigned JWT whose payload is `{"role":"service_role"}`). Pass when the app refuses both with "This is a secret / service-role key…" and stores neither. This works because `isPrivilegedKey` (`packages/api-client/src/connection.ts`) checks the `sb_secret_` prefix and the JWT payload's `role` claim only, never a signature. |
| 7 | Install on Android | Chrome menu → Install app (or Add to Home screen). The icon, name, standalone window and maskable icon look right. |
| 8 | Install on iOS/iPadOS | Safari → Share → Add to Home Screen. The apple-touch icon, title and status bar look right. |
| 9 | Notification permission | Asking happens only after a user gesture. On Android Chrome without a service worker, Tavro explains that page notifications are unavailable. On iOS 16.4+, they're offered only in the Home Screen app. Notification text is generic (D-009). |
| 10 | Offline banner | Airplane mode shows the offline banner and pauses alert detection. Reconnecting recovers. |
| 11 | Paused or unreachable project | With a wrong URL, the app shows the "can't reach the backend" state within about 20 s plus the stale window. |
| 12 | Privacy spot-check | DevTools → Application: local storage holds no transcript or session text. There's no service worker and no Cache Storage. |
| 13 | iOS CSP | **Can't be checked without a Mac.** Safari's console for an iPhone or iPad is only reachable through Web Inspector on macOS. Without one, record iOS CSP and Trusted Types behaviour as *unverified*. Check 8 (the app works on iOS) is then the only iOS evidence. |
| 14 | Live updates with public Realtime access off | With "Allow public access" **off** (step 2.5) and the mock connector from step 9b running, a session's status change shows on the dashboard within a few seconds, well before the 30 s poll. In DevTools → Network → WS, the Realtime socket joins a `tavro-changes:…` topic, and the join succeeds. *Unverified* until provisioning: D-022's private-channel policy has only been tested at SQL level. If updates arrive only every 30 s, Realtime authorization is failing and the poll is covering for it. Record that and investigate; never turn public access on to fix it. |

## 9b. Post-provisioning smoke test [manual]

This proves isolation and revocation on the **hosted** project, which `test:db` (local stack only) can't. Use the mock provider only, never the real adapter. Record the result in `docs/QUALITY.md` with the date.

1. **Anonymous access is refused.** Run `curl -s "https://<ref>.supabase.co/rest/v1/sessions?select=id" -H "apikey: <publishable key>"`. Pass when it returns an empty list or a permission error, never rows. Repeat for `hosts` and `session_events`.
2. **Transcript storage is off** (step 3, D-022). Run `curl -s "https://<ref>.supabase.co/rest/v1/app_meta?select=transcripts_enabled" -H "apikey: <publishable key>"`, or `select transcripts_enabled from public.app_meta;` in the SQL editor. Pass when it returns `false` (`[{"transcripts_enabled":false}]`). If it returns `true`, the seed ran on this project: stop, set it back with `update public.app_meta set transcripts_enabled = false;` in the SQL editor, delete any rows in `public.session_messages`, and find out how (step 3's "never" list) before going on. Repeat this check after every later migration push.
3. **Sign-ups are off.** The app has no sign-up screen, so use the API: `curl -s -X POST "https://<ref>.supabase.co/auth/v1/signup" -H "apikey: <publishable key>" -H "content-type: application/json" -d '{"email":"smoke@example.invalid","password":"<16 random characters>"}'`. Pass when it is refused. If it succeeds, sign-ups are on: delete that user, fix step 2.4 and repeat.
4. **Pair a mock host.** In the app, signed in as the owner: Hosts → **Pair a new host**, name it `smoke-test`, and copy the code. On the laptop, use a separate data directory so real credentials aren't touched: in `apps/connector/.env`, set `MC_SUPABASE_URL=https://<ref>.supabase.co`, `MC_SUPABASE_PUBLISHABLE_KEY=<publishable key>`, `MC_PROVIDER=mock` and `MC_DATA_DIR=.data-smoke`. Then run `npm run connector -- pair <CODE>` and `npm run connector -- run`.
5. **The owner sees only that host.** The Hosts page lists exactly one host, `smoke-test`, and the dashboard shows only its sessions, each labelled DEMO.
6. **Revoke it.** Revoke `smoke-test` in the app. Pass when, within one poll cycle (5 s by default), the running connector's writes **fail** (errors in its log, never a successful cycle), and the host's sessions stop changing in the app. Stop the connector.
7. **The revoked credential stays dead.** Run `npm run connector -- run` again with the same `.data-smoke`. It must fail, not sync.
8. **Global sign-out works** (step 2.4). With the app signed in on two browsers, Sign out on one. Pass when the other is signed out within about 15 minutes.
9. **Clean up.** Delete `apps/connector/.data-smoke/`, restore `apps/connector/.env`, and delete the `host-<id>@hosts.tavro.invalid` user in Dashboard → Authentication → Users (revocation doesn't delete it; SECURITY.md known gap 4).

If any step fails, stop: don't continue to step 10, and treat the deployment as broken (step 11).

## 10. Switch CSP to enforcing [AUTH] [GATE]

**Window:** switch **no later than 14 days** after the first deployment, and only once check 5 is clean in both modes.

Why a fixed window: Report-Only blocks nothing, so every day in that mode is a day without CSP protection. And with no `report-uri`, a longer window gathers no evidence by itself: violations only show up when someone runs check 5. Fourteen days is enough to repeat check 5 across a Free-plan pause and restore (about 7 days), several token refreshes and Realtime reconnects, and one patch release. If the deadline passes, record the blocking violation and a new date in `docs/DECISIONS.md`. Don't leave it open-ended.

1. Make the change in `deploy/cloudflare/_headers`: rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` and keep the value unchanged.
   - **Exception, Trusted Types:** if check 5 showed Trusted Types reports that can't be fixed in this window, move `require-trusted-types-for 'script'; trusted-types 'none'` into a separate `Content-Security-Policy-Report-Only` line, enforce the rest, and record that in `docs/DECISIONS.md`.
   - Update the generator test (`scripts/generate-headers.test.mjs`), which asserts the mode.
2. Commit the change. Re-establish the test:db gate for the new commit, then repeat steps 6 to 9.
3. `check:dist` should now report `CSP mode: enforcing`. Check 5 should still show no violations, and the app should work.

## 11. Rollback

- **Bad web release:** in Cloudflare Pages → Deployments, roll back to the previous deployment, which step 8.6 keeps. This is instant and static, and no data is involved. Old tabs that request removed chunks get the retry screen.
- **CSP breaks the app after step 10:** roll back the deployment, or redeploy with Report-Only.
- **Stop serving entirely:** delete the Pages project or its custom domain. Session data lives in Supabase, not on the host.
- **Supabase:** see steps 3 and 5. To revoke a laptop, revoke its host in the app. Pausing or deleting the project stops all syncing.
- **Suspected key leak:** see Operations → Key rotation.

## Operations

### Retention of `session_events`

Every status change adds a row, and nothing deletes them. There is deliberately **no** retention migration: a purge is a data deletion the owner should run knowingly. Recommended: once a month, in the Dashboard SQL editor, keep 90 days.

```sql
-- 1. Preview what would go.
select count(*) from public.session_events
where occurred_at < now() - interval '90 days'
  and dedupe_key <> 'discovered';

-- 2. Delete, in a transaction. Check the reported row count against step 1 before committing.
begin;
delete from public.session_events
where occurred_at < now() - interval '90 days'
  and dedupe_key <> 'discovered';
commit;   -- or rollback;
```

`discovered` events are kept: their `(session_id, dedupe_key)` uniqueness is what stops a restarted connector from re-inserting a "discovered" event for a session it still lists. Clients subscribe to INSERT and UPDATE only (`subscribe` in `packages/api-client/src/supabase-api.ts`), so the deletes wake no client. To remove old ended sessions too, `delete from public.sessions where ended_at < now() - interval '90 days';` cascades to their events.

### Backups

- **Free has no backups.** This is accepted for the first deployment: the data is regenerable. A running connector re-reports every current session within one poll. What's lost is history (ended sessions, past events) and host pairings, which can be redone.
- Before a later migration, take a dump from a non-corporate machine (`npx supabase db dump --data-only`, step 3's token rules apply), or accept the loss.
- Pro adds daily backups. That's a paid decision.

### Monitoring and logs

- There is no third-party telemetry, and there will be no alerting service. Monitoring is manual: the app's own banners (offline, paused, unreachable, source not responding), the Supabase Dashboard (usage, Auth logs, function logs) and the email Supabase sends before pausing a Free project.
- **Log retention is short:** 1 day on Free for API, Auth and Edge Function logs (PHONE_ACCESS §2). Investigate an incident the same day, or the evidence is gone. For Cloudflare Pages, the request logs available for static assets on the free plan are *unverified*; assume none, since Web Analytics stays off.
- Check Dashboard → Usage weekly against the Free limits (Realtime connections and messages, function invocations).

### Incident runbooks

**Owner account compromised** (password leaked, or a signed-in device lost or stolen):
1. Sign in on a trusted device and **Sign out**, which is global and revokes every refresh token (step 2.4). Access tokens die within 15 minutes.
2. Change the owner password (Dashboard → Authentication → Users), and check that the account's email address hasn't changed.
3. Check Hosts for any host you didn't pair. An attacker with the owner login can create pairing codes. Revoke unknown hosts, and delete their `host-…` users.
4. Read the Auth logs **today** (1-day retention) for sign-ins you don't recognise.
5. The attacker could read all session metadata (see **What leaves the laptop**). If IT cleared the upload in step 1, tell them.

**Host credential stolen** (`apps/connector/.data/host.json` copied):
1. Revoke the host in the app. This applies immediately, even to a still-valid token (`active_host_id()` re-checks it).
2. Delete that host's `host-<id>@hosts.tavro.invalid` user in the Dashboard.
3. Delete `host.json` on the laptop, create a new pairing code and pair again. The new pairing is a new host.
4. Treat what that host wrote before revocation as untrusted: the thief could write fake sessions for it, but nothing for other hosts (RLS). Read access was limited to that host's own rows.

**Cloudflare account compromised:**
1. The attacker can replace the app with one that captures the owner's password or the stored session. The static host holds no data, so the risk is to the owner's credentials.
2. Recover the account (MFA recovery codes from step 1b), and remove unknown members, API tokens, custom domains, Workers and bindings.
3. Roll back to a deployment you uploaded, or upload a fresh build of the release commit (steps 6–8), or delete the project until it's clean.
4. Then run **Owner account compromised** in full: assume the password and session were captured.

### Key rotation

| Key | Rotate when | What it breaks |
|---|---|---|
| **Publishable key** (`sb_publishable_…`) | It's public by design, so only for hygiene or after abuse. Create a new one in Dashboard → API Keys, then delete the old one. | Every app install and every connector holding the old key: the app shows its rejected-key screen and needs **Change backend** with the new key, and each `apps/connector/.env` needs the new key. Owner sign-ins and host logins themselves stay valid. |
| **Secret key** (`sb_secret_…`) | At once if it was ever seen outside the Dashboard. Create a new one, then delete the old one. If legacy JWT keys are enabled, disable them too. | Only `pair-host`, which is the only user. New pairings fail until the function gets the new key; whether the injected `SUPABASE_SECRET_KEYS` updates without a redeploy is *unverified*, so redeploy it (step 5). Paired hosts and the app keep working. |
| **JWT signing key** | If it may have leaked, or as the provider recommends. Use Dashboard → JWT Keys: create a standby key, rotate, then revoke the old one. | Revoking the old key invalidates every access token it signed. The owner's app and every connector must refresh or sign in again, and Realtime reconnects. Refresh tokens should survive, so clients probably recover on their own (*unverified*). Changing a **legacy** JWT secret also replaces the legacy anon and service-role keys, which breaks everything still using them. |
| **Database password** | If it leaked. Reset it in Dashboard → Database settings. | Nothing in Tavro; only CLI `link` and `db push` need it. |

## Afterwards

- Update `docs/QUALITY.md`: change release-checklist rows from unverified to manual or verified only for checks that actually ran.
- Record each authorization and the deployment URL's visibility decision in `docs/DECISIONS.md`.
- If the CLI ran on the corporate laptop, confirm `npx supabase logout` ran and the access token is deleted in the Dashboard (step 3).
