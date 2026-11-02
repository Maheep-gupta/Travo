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
| Anonymous | Publishable key | Read `app_meta.schema_version` only |
| Owner | Supabase Auth user JWT | Read own hosts, sessions, events and messages. Rename or revoke own hosts. Manage own preferences. Create pairing codes. |
| Host (connector) | Supabase Auth user created by `pair-host`, with `app_metadata` `{mc_role: "host", host_id}` | Write and read only its own host's sessions, events and messages. Heartbeat. |
| Edge Function | Project secret key (server-side) | Redeem pairing codes and create host users |

## Controls

**Data isolation (RLS):**
- Every table has RLS enabled.
- All privileges are revoked from `anon` and `authenticated`, then granted back per table and per column.
- Owner policies use `owner_uid()`, which is null for host principals.
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

**Transcript content:** only written when `MC_SYNC_TRANSCRIPTS=true` **and** the backend URL is a loopback address. There's no override in this release.

**Realtime:**
- Clients use Postgres Changes, which respect RLS. Data is re-read through RLS-checked queries.
- The JWT lifetime is 15 minutes, which bounds how long Realtime keeps a cached permission.

**Errors:** the api-client maps database errors to generic messages, so no SQL text reaches the UI.

**Abuse:** the pending-pairing cap is the only rate limit implemented. Supabase Auth applies its own login rate limits (`[auth.rate_limit]` in `config.toml`).

**Demo data:** every simulated session, event and message is flagged `is_demo` and labelled DEMO in the UI.

**Session source health (schema v2, 2026-11-02):**
- `hosts.provider_error_since` is written **only** by the security-definer `host_heartbeat(…, p_provider_ok)` for the caller's own active host.
- No role has a column UPDATE grant for it, and a null health value is rejected.
- Owners read it like any other column on their own hosts.
- The UI never shows a stored session status as current while it is set.
- Test cases are in `supabase/tests/rls.test.ts`, **written, not yet run** (Docker). The same behaviour passes at SQL level (PGlite, `npm run test:sql`, part of `npm test`) on the repository's migrations; still unverified via PostgREST and `test:db`.

**Out-of-order session writes (schema v3, 2026-11-02):**
- `sessions.observed_at` is required on every write and clamped by trigger to `now() + 5 minutes`, so a host with a wrong clock can't pin its own sessions for longer than that.
- An update with an older `observed_at` is skipped silently by `sessions_guard_update`. The immutable-column checks run first, so a stale write can't be used to slip past them.
- This is an integrity rule, not an access rule. It only orders writes a host can already make: RLS still allows session writes only from the active host that owns the row, and owners still can't write sessions. `observed_at` gets the same column grants as the other connector-written columns.
- v3 also grants UPDATE on `host_id`, `provider` and `external_id`. PostgREST upserts set every payload column on conflict, and without these grants the second upsert of a row would very probably fail with 42501. The trigger rejects any change to them, and `rls.test.ts` asserts the trigger's own error for a forged move. Another host's upsert against this host's conflict key is refused by RLS (test added).
- If writes keep being skipped, or keep failing after a good heartbeat, the connector reports its source as not responding after 3 cycles (D-015). A host whose clock is behind therefore can't present frozen statuses as current.
- Test cases are in `supabase/tests/rls.test.ts` ("stale-write guard"), **written, not yet run** (Docker).
- **SQL level (PGlite, `npm run test:sql`, 2026-11-03):** the stale skip (absent from RETURNING, row unchanged, per-row in a batch), equal-time and omitted-`observed_at` updates, null → 23502, the `now() + 5 min` clamp, the v3 key-column grants under a PostgREST-shaped upsert, the forged-move refusal, the cross-host freeze refusal and the `-infinity` backfill all behave as described, on the repository's migrations including the fix below. Still unverified via PostgREST and `test:db`.
- **Defect found (2026-11-03, SQL level):** `set_owner_from_host` (v1) references `new.session_id` inside an `if … and not exists (…)` condition. PL/pgSQL resolves every field in an expression before evaluating it, so on `sessions`, which has no `session_id`, every insert fails with `42703 record "new" has no field "session_id"`. Hosts can't create sessions at all. **Fixed** by `supabase/migrations/20261104000001_fix_set_owner_from_host.sql`, which nests the session check in its own `if tg_table_name in (…)` block. Function body only, so the schema version stays 3 (D-021).

## Sign-in sessions on the device (2026-11-03)

- **One stored session per project.** The supabase-js session is stored under `tavro.auth:<project origin and path>` (`authStorageKey`). Before this, one fixed key `tavro.auth` was shared by every project. After **Change backend**, project X's access token could reach project Y, and its refresh token could later be posted to Y's `/auth/v1/token` (security review M1). The legacy key and its `-user` and `-code-verifier` entries are deleted unread on start, so existing users sign in once more.
- **Change backend** closes the old backend first (`TavroApi.close()`): it removes that project's stored session, tells other tabs, and disconnects Realtime. It sends no logout to either project, because people often switch away from a project that is unreachable or refuses the key. Ending the session on the server is what Sign out is for.
- **Sign out** always removes the local session, even if auth-js can't load it. It returns `{ serverRevoked }`, and when the project wasn't told, the sign-in page says so. A rejected publishable key gets its own screen, with a local-only Sign out (D-020).
- **Alert history** is kept when a sign-in ends and cleared on an explicit Sign out or when a different user signs in (last user id per backend, id only). Alert detection skips any rows whose `owner_id` isn't the signed-in user, which covers a refetch with another tab's newer token.
- **Error codes:** `misconfigured` for a rejected key and `rate_limited` for 429. Neither is retried. Response text is pattern-matched, never shown.
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
