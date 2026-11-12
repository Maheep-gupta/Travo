# Security model and threat assessment

**Status:** The controls below are implemented in code. The **database-level controls are not yet verified**, because the RLS test suite can't run until Docker works. Treat them as unverified until `npm run test:db` passes.

## Assets

- Claude session metadata and status.
- Transcript excerpts, which are sensitive. They stay on the laptop and only go to a loopback database.
- Host credentials (`apps/connector/.data/host.json`).
- The owner's Supabase login.
- The project's secret key, which exists only inside Edge Functions.

## Principals

| Principal | Credential | Can |
|---|---|---|
| Anonymous | Publishable key | Read `app_meta` only (`schema_version`, and `transcripts_enabled`, which reveals whether the project stores transcripts but no content) |
| Owner | Supabase Auth user JWT | Read own hosts, sessions, events and messages. Rename or revoke own hosts. Manage own preferences. Create pairing codes. |
| Host (connector) | Supabase Auth user created by `pair-host`, with `app_metadata` `{mc_role: "host", host_id}` | Write and read only its own host's sessions, events and messages. Heartbeat. |
| Edge Function | Project secret key (server-side) | Redeem pairing codes and create host users |

## Controls

**Data isolation (RLS):**
- Every table has RLS enabled.
- All privileges are revoked from `anon` and `authenticated`, then granted back per table and per column.
- Owner policies use `owner_uid()`, which is null for any token whose app_metadata has an `mc_role` key, including a host claim with a malformed `host_id` (it failed open before migration `20261105000001`).
- Host policies use `active_host_id()`, which re-checks that the host isn't revoked, so revocation applies immediately even with a still-valid token.

**Integrity:**
- `owner_id` on rows a host writes is set by trigger from the host record.
- Events and messages must reference a session belonging to the same host.
- A session's owner, host, provider and external id can't be changed.
- Revocation can't be undone.

**Identity forgery:**
- Host identity comes from `app_metadata`, which only the secret key can write. `user_metadata` is ignored.
- A test covers a user who signs up claiming to be a host.

**Pairing:**
- Codes are 12 characters from a 32-character alphabet, single-use and valid for 10 minutes. Only their SHA-256 is stored.
- At most 5 pairings can be pending per owner.
- The same error is returned for unknown, used and expired codes.
- A race is handled by deleting the orphaned login.

**Secrets:**
- Clients accept only the publishable key. Secret keys and service-role JWTs are rejected by the web app, the api-client and the connector config.
- Supabase also rejects secret keys sent from browsers.
- `.env`, `.data/` and `supabase/functions/.env` are git-ignored.

**Transport:**
- The local dev and preview servers bind to `127.0.0.1`.
- Remote Supabase URLs must use `https://`. `http://` is allowed only for loopback addresses.
- The connector makes outbound connections only; it opens no inbound ports.

**No remote execution:**
- The connector has no command channel.
- Replies, resume and approvals are disabled. Control capabilities need both a feature flag and an explicit org allowance, and an unknown policy counts as "not allowed".

**Transcript content:** only written when `MC_SYNC_TRANSCRIPTS=true` **and** the backend URL is a loopback address. There's no override in this release. Since migration `20261105000001` the database enforces it too: hosts can insert `session_messages` only while `app_meta.transcripts_enabled` is true. It defaults to false, no API role can change it, and only the local stack's `supabase/seed.sql` turns it on. `supabase db push` (the hosted runbook) doesn't load the seed; `--include-seed`, `supabase db reset --linked` and Supabase Branching all would, so none is ever used on a hosted project (DEPLOYMENT.md step 3), and the hosted smoke test checks the flag is false (step 9b). `session_messages` is not in the Realtime publication. The connector treats a refused transcript insert (42501) as "storage is off" only after reading `transcripts_enabled = false`; the same code from the owner trigger or a revoked host's RLS stays an ordinary error.

**Claude Code child process:** a bare `claude` is resolved on PATH by the connector, skipping relative entries (Windows would otherwise search the current directory first), and spawned by absolute path without a shell and with an allow-listed environment (no `MC_*`, `NODE_OPTIONS`, proxies or keys). An unrecognised CLI status is sent as fixed text, never quoted (docs/INTEGRATIONS.md).

**Realtime:**
- Clients use Postgres Changes, which respect RLS, for invalidation only. Payloads are ignored; data is re-read through RLS-checked queries.
- The app joins a **private** channel, `tavro-changes:<random>`, so Realtime "Allow public access" stays off. It listens to INSERT and UPDATE on `sessions` and `session_events` only. Never DELETE, which Realtime doesn't filter by RLS; rows are never deleted anyway, and revocation is a flag. Never `hosts`: the 30 s heartbeat would wake every client, so the host list is polled and `hosts` is not in the publication.
- `realtime.messages` has one policy, a SELECT for owners (`owner_uid()` not null) on `tavro-changes:*` topics. Hosts and anon can't join. There is no INSERT policy, so no client can broadcast or track presence on the topic. The topic is shared by name prefix and carries nothing beyond each subscriber's own RLS-filtered changes. Any future Broadcast use needs per-owner topics.
- The JWT lifetime is 15 minutes, which bounds how long Realtime keeps a cached permission.

**Capabilities (D-003):** the `sessions.capabilities` check accepts only `discover`, `get_details`, `read_messages` and `subscribe_events`. A stolen host credential therefore can't make the dashboard offer replies, resume or approvals. Re-widening it needs D-003 to change.

**Errors:** the api-client maps database errors to generic messages, so no SQL text reaches the UI.

**Abuse:** the pending-pairing cap is the only rate limit implemented. Supabase Auth applies its own login rate limits (`[auth.rate_limit]` in `config.toml`).

**Demo data:** every simulated session, event and message is flagged `is_demo` and labelled DEMO in the UI.

**Session source health (schema v2, 2026-11-02):**
- `hosts.provider_error_since` is written **only** by the security-definer `host_heartbeat(…, p_provider_ok)` for the caller's own active host.
- No role has a column UPDATE grant for it, and a null health value is rejected.
- Owners read it like any other column on their own hosts.
- The UI never shows a stored session status as current while it is set.
- Test cases are in `supabase/tests/rls.test.ts`, **written, not yet run** (Docker). The same behaviour passes at SQL level (PGlite, `npm run test:sql`, part of `npm test`) on the repository's migrations; still unverified via PostgREST and `test:db`.

**Source failure categories (schema v4, 2026-11-12, D-026):**
- `hosts.provider_error_kind` holds one of a fixed list of categories (`cli_missing`, `auth_required`, `timeout`, `invalid_output`, `incompatible_version`, `interrupted`, `failed`, `writes_not_applied`) or null. A CHECK constraint enforces the list on every write, even the database owner's, and a second check allows a category only while `provider_error_since` is set.
- Written **only** by the security-definer `host_heartbeat(…, p_provider_ok, p_provider_error_kind)` for the caller's own active host. It rejects a category on a healthy report and any value outside the list (`22023`). No column grants were added: owners keep `update (name, revoked_at)`, hosts have no UPDATE on `hosts`, and the new function is revoked from `public` and `anon` and granted to `authenticated` only, like v2's.
- Only the category crosses the wire: never the provider's message, stderr, a path, a version string or anything else from the CLI. The connector passes on a provider's category only if it is in the list (anything else becomes `failed`), and `MemoryTransport` and the contracts mirror the rule.
- The web app never shows the stored value itself: `sourceFailureText` maps it to fixed text, and an unknown value reads as the generic message. `HostRow` parses an unknown category as null, so a newer category can't fail the host list.
- `hosts` stays out of the Realtime publication (D-022), so the column isn't broadcast.
- **SQL level (PGlite, 2026-11-12):** valid and invalid categories, free text, a category on a healthy report, recovery clearing both columns, a v3 connector's four-argument call, refusal for owners and anon, no direct UPDATE by owners or hosts, the CHECK constraints against the database owner, cross-owner reads, the v3 → v4 upgrade with an ongoing failure, and the function's grants. Matching cases are in `supabase/tests/rls.test.ts`, **written, not yet run** (Docker).

**Out-of-order session writes (schema v3, 2026-11-02):**
- `sessions.observed_at` is required on every write and clamped by trigger to `now() + 5 minutes`, so a host with a wrong clock can't pin its own sessions for longer than that.
- An update with an older `observed_at` is skipped silently by `sessions_guard_update`. The immutable-column checks run first, so a stale write can't be used to slip past them.
- This is an integrity rule, not an access rule. It only orders writes a host can already make: RLS still allows session writes only from the active host that owns the row, and owners still can't write sessions. `observed_at` gets the same column grants as the other connector-written columns.
- v3 also grants UPDATE on `host_id`, `provider` and `external_id`. PostgREST upserts set every payload column on conflict, and without these grants the second upsert of a row would very probably fail with 42501. The trigger rejects any change to them, and `rls.test.ts` asserts the trigger's own error for a forged move. Another host's upsert against this host's conflict key is refused by RLS (test added).
- If writes keep being skipped, or keep failing after a good heartbeat, the connector reports its source as not responding after 3 cycles (D-015). A host whose clock is behind therefore can't present frozen statuses as current.
- Test cases are in `supabase/tests/rls.test.ts` ("stale-write guard"), **written, not yet run** (Docker).
- **SQL level (PGlite, `npm run test:sql`, 2026-11-03):** the stale skip (absent from RETURNING, row unchanged, per-row in a batch), equal-time and omitted-`observed_at` updates, null → 23502, the `now() + 5 min` clamp, the v3 key-column grants under a PostgREST-shaped upsert, the forged-move refusal, the cross-host freeze refusal and the `-infinity` backfill all behave as described, on the repository's migrations including the fix below. Still unverified via PostgREST and `test:db`.
- **Defect found (2026-11-03, SQL level):** `set_owner_from_host` (v1) references `new.session_id` inside an `if … and not exists (…)` condition. PL/pgSQL resolves every field in an expression before evaluating it, so on `sessions`, which has no `session_id`, every insert fails with `42703 record "new" has no field "session_id"`. Hosts can't create sessions at all. **Fixed** by `supabase/migrations/20261104000001_fix_set_owner_from_host.sql`, which nests the session check in its own `if tg_table_name in (…)` block. Function body only, so the schema version stays 3 (D-021).

**Security hardening (migration `20261105000001_security_hardening.sql`, 2026-11-03, D-022):**
- Findings from the independent review, all reproduced at SQL level on migrations v1 to `20261104000001` before the fix:
  - **S4:** a token with `mc_role: "host"` and `host_id: "not-a-uuid"` got `owner_uid()` equal to its `sub`, and could create pairings.
  - **S3:** the capabilities check allowed `send_message`, `resume` and `approve_requests`.
  - **S2:** `messages_host_insert` checked only the host.
  - **M5:** `hosts` was published, the client subscribed to `*` (including DELETE) on a public channel, and `realtime.messages` had no policies.
- **SQL level (PGlite, `npm run test:sql`):** each fix is covered. That covers the malformed-claim cases, any `mc_role` value, user_metadata ignored, and an upper-case host id still accepted. It also covers the control capabilities refused (23514), the transcript insert refused while disabled and allowed while enabled, and the flag not writable by owner, host or anon. Finally it covers the publication, the emulated private-channel decision (owners may receive, nobody may send, hosts, anon and other topics refused), the replaced helpers keeping their owner, invoker security and grants, and the upgrade path (stored control capabilities stripped, stored transcripts kept).
- **Written, not yet run** (`rls.test.ts`, needs Docker): the same cases through GoTrue and PostgREST, plus a real private-channel join for owner, host and an unlisted topic.
- **Unverified until `test:db` or a provisioned project:**
  - Whether real Realtime admits a private channel used only for Postgres Changes with this policy. The SQL tests emulate its check, they don't run it.
  - Whether `db reset` applies a policy on `realtime.messages` cleanly. The table is created by the Realtime service; if it doesn't exist yet the migration fails loudly rather than skipping.
  - Whether `service_role` can update `app_meta` through PostgREST, which the rls tests use to switch the flag.

## Sign-in sessions on the device (2026-11-03)

- **One stored session per project.** The supabase-js session is stored under `tavro.auth:<project origin and path>` (`authStorageKey`). Before this, one fixed key `tavro.auth` was shared by every project. After **Change backend**, project X's access token could reach project Y, and its refresh token could later be posted to Y's `/auth/v1/token` (security review M1). The legacy key and its `-user` and `-code-verifier` entries are deleted unread on start, so existing users sign in once more.
- **Change backend** closes the old backend first (`TavroApi.close()`): it removes that project's stored session, tells other tabs, and disconnects Realtime. It sends no logout to either project, because people often switch away from a project that is unreachable or refuses the key. Ending the session on the server is what Sign out is for. `close()` and Sign out resolve only once the store has removed the session, which matters for an async store such as the future Expo app's (re-check I1).
- **Projects left behind (re-check L2, 2026-11-12):** a tab still open on project X could sign back in to it after another tab had left X. Every new backend now removes the stored sign-ins of all other projects, unread (`removeOtherAuthSessions`); demo mode keeps none. This needs a store that can list its keys (web storage can; expo-secure-store can't, so the Expo app will need its own index). A stale tab can still sign in to X again; that sign-in lasts until the next backend is created on the device. The sweep keeps only the current project's exact entries (`isAuthEntryOf`: the session key, `-user`, `-code-verifier`, `-flows-code-verifier` and `-flow-<32 hex>-code-verifier`, the names auth-js uses), not every key that starts with it: `https://p.supabase.co-x.example.com` is a different project whose key begins with `https://p.supabase.co-` (security review L2, 2026-11-12).
- **One backend per choice (re-check I3):** React StrictMode (development only) no longer creates a second client that nobody closes.
- **Sign out** always removes the local session, even if auth-js can't load it. It returns `{ serverRevoked }`, and when the project wasn't told, the sign-in page says so. A rejected publishable key gets its own screen, with a local-only Sign out (D-020).
- **Alert history** is kept when a sign-in ends and cleared on an explicit Sign out or when a different user signs in (last user id per backend, id only).
- **Reads pinned to the user (re-check L3, 2026-11-12):** the session list, host list and notification preferences are read with `asUser`. The request carries the token whose JWT `sub` was checked, or nothing is sent: another account's sign-in fails with `account_changed`, and a missing one with `unauthorized`. Before this, a sign-in in another tab could answer this tab's queries with that account's empty lists or unsaved (default) preferences, which the `owner_id` check couldn't catch. That check stays as a second line. On `account_changed` the app follows the stored sign-in instead of waiting for an auth event; if it can't be read then (offline), A's own last data stays on screen as not refreshing, and the app tries again when the browser is back online or the next pinned query is refused.
- **Everything else pinned too (security review L1, 2026-11-12):** the app also pins the session page's reads (`getSession`, `listEvents`, `listMessages`) and every write: `createHostPairing`, `revokeHost` and `saveNotificationPrefs`, which saves under the checked user's `owner_id`. Before this, a tab signed in as A could create a pairing code while another tab had signed in as B: the code belonged to B, so A's laptop would have synced to B's account. A save would also have been cached under A's key. Every `TavroApi` request about user data now takes `asUser`; only `getSchemaVersion` and the auth calls don't. The unpinned form stays for tests and tools, and the app's calls all pass it.
- **A token whose `sub` can't be read** fails a pinned request with `account_changed` (security review I1). It never falls back to the user record stored beside the token, which says nothing about whom the database would answer as.
- **A refresh that gets no answer** (network failure, a 5xx) fails a pinned request as `unavailable`, not `unauthorized`, so an outage doesn't sign the user out. Only a refused refresh does (tested in `stored-sign-ins.test.ts`).
- **Error codes:** `misconfigured` for a rejected key, `rate_limited` for 429, `account_changed` for a pinned request under another account. None is retried. Response text is pattern-matched, never shown.
- **Not verified in a real browser:** cross-tab behaviour, with auth-js's BroadcastChannel and storage.

## Known gaps and risks

1. **RLS unverified** until Docker works. This is the gate for enabling real data.
2. **Host credentials** are stored as a JSON file. On Windows the `0600` file mode is advisory. Better: use the OS credential store (DPAPI or Keychain), not implemented. The file sits inside the git-ignored project folder.
3. **Sign-ups are open** in local config (`enable_signup = true`). Other sign-ups can't see the owner's data because RLS isolates them. For a cloud or BYOS project, disable sign-ups after creating the owner account.
4. **Revoking a host doesn't delete its Auth user.** Access is denied by RLS. A cleanup Edge Function would be good hygiene.
5. **Brute-forcing pairing codes:** there are 32¹² possible codes and each lasts 10 minutes, so this is impractical. The `pair-host` function has no per-IP limit.
6. **Company policy:** Remote Control is disabled by your organisation. Don't build a relay or any other mechanism that recreates it. Any cloud use, even metadata-only BYOS, should be cleared with IT first.
7. **Supply chain:** dependencies are pinned by `package-lock.json`. npm blocked the `esbuild` install script, which isn't needed.

## Before enabling real Claude Code data

- [ ] `npm run db:reset` applies the migration cleanly.
- [ ] `npm run test:db` passes.
- [ ] `npm run db:lint` reports no security warnings.
- [ ] Pairing and revocation verified end to end.
- [ ] Adapter reviewed: reads only `claude agents --json`, plus transcripts through the SDK when opted in. Never reads `~/.claude/sessions/*.key`.
