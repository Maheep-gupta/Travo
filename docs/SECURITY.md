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
