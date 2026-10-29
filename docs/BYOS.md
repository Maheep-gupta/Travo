# Bring Your Own Supabase (BYOS): Feasibility Report

**Status:** Feasibility study only. Nothing described here is implemented. Nothing has been provisioned, and no Supabase project has been touched.
**Date:** 2026-10-29
**Decision needed:** Choose between direct BYOS, BYOS plus relay, or keeping the self-hosted API (see section 9).

Evidence labels:
- **[Docs]**: confirmed in official Supabase documentation (links at the end).
- **[Inference]**: my engineering judgement from those docs, not tested.
- **[Unverified]**: needs a hands-on test before we rely on it.

---

## 1. The question

Can each user keep their Tavro data in a Supabase project they own? That data is:
- session metadata
- event history
- command records
- notification preferences
- device registrations

The aim is to avoid one shared database run by the application developer.

**What BYOS cannot replace:**
- **The local connector.** Only a process on the laptop can see Claude Code sessions, read hook events and run `claude` commands. Supabase is a remote database and messaging service, so it cannot observe a laptop.
- **The Claude integration rules.** These come from the feasibility audit (to be written up in `docs/FEASIBILITY.md`): sessions that are still open cannot receive replies through a supported API. Remote Control is disabled by this user's organisation (`allow_remote_control: false` in the managed policy).

## 2. Constraints carried forward

1. Real Claude session data stays local unless the user explicitly authorises uploading it. BYOS uploads **metadata only by default**:
   - status
   - timestamps
   - session name
   - integration type
   - a *hashed or aliased* project path
   - **no** transcript content
2. Remote commands are disabled when the host's Claude policy disallows Remote Control. The connector should read `policy-limits.json`, which is policy data rather than a credential, and refuse remote commands when that flag is false.
3. Privileged keys never reach the web or mobile client. This covers the secret key, the `service_role` key, the database password, and Management API tokens.
4. No silent provisioning and no schema changes without explicit user approval.

## 3. Supabase facts that drive the design

| Fact | Source |
|---|---|
| **Publishable key** (`sb_publishable_…`) is safe in browsers and mobile apps. It runs requests as `anon`, or as `authenticated` with a signed-in user, and access is limited by table grants and RLS. | [Docs] API keys |
| **Secret key** (`sb_secret_…`) bypasses RLS. It must never appear in a browser, and Supabase rejects browser requests that use it (HTTP 401, detected from the User-Agent). | [Docs] API keys |
| Legacy `anon` and `service_role` keys are planned for deprecation by the end of 2026. Use the new keys. | [Docs] API keys |
| Realtime **Postgres Changes respect RLS**. Broadcast and Presence on **private channels** are authorised by RLS on `realtime.messages`. Public access must be turned off in Realtime settings. | [Docs] Realtime Authorization |
| Realtime permissions are **cached until the JWT expires**, so a revocation is not instant. Keep JWT lifetimes short. | [Docs] Realtime Authorization |
| Edge Functions get `SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_JWKS` automatically. Custom secrets are set through the CLI or Dashboard, and setting them requires the Owner or Admin role. | [Docs] Edge Function secrets |
| **Free plan:** 2 active projects, 500 MB database, 5 GB egress, 50k monthly active users, 200 concurrent Realtime connections, 2M Realtime messages a month, 500k Edge Function calls, **no backups or point-in-time recovery**. | [Docs] Pricing |
| **Free projects pause after about 7 days without enough database activity.** Paid projects never pause. Pro starts at $25 a month. | [Docs] Pricing, Project Pausing |
| OAuth apps can create projects and fetch API keys through the Management API. Scopes are per endpoint, read or write, and fixed when the app is created. The database password **cannot** be retrieved through the API. I found no documented scope that lets an app run arbitrary SQL. | [Docs] OAuth integration and scopes |

**Answer to "do a URL and publishable key authorise arbitrary operations?"** No.
- The publishable key only identifies the project.
- What a client can do is set entirely by grants and RLS policies in our schema.
- The schema must therefore:
  - `REVOKE ALL` from `anon`
  - grant only the minimum to `authenticated`
  - enable RLS on every table
- Anything privileged runs in Edge Functions that hold the secret key on the server.

## 4. Option A: direct BYOS (no developer-hosted backend)

```
 Phone / Web (publishable key + user JWT)        Laptop connector (host JWT)
            │  HTTPS + WSS                                │  outbound HTTPS + WSS only
            ▼                                             ▼
   ┌──────────────── User's Supabase project ─────────────────┐
   │ Auth  ·  Postgres (+RLS)  ·  Realtime  ·  Edge Functions │
   │                                   │                      │
   │      DB webhook / pg_net ─────────┘→ notify fn ─→ Web Push / Expo Push
   └──────────────────────────────────────────────────────────┘
 Developer hosts: static web app only (+ Expo builds later)
```

**How each piece works**

- **Owner sign-in:** Supabase Auth with email OTP or a magic link, using the user's own project.
  - **[Docs]** The built-in email sender is heavily rate-limited. A real deployment needs the user to configure their own SMTP, which adds onboarding friction.
  - **[Inference]** Passkeys or OAuth providers are possible alternatives, but each needs setup in the user's project.
- **Host (connector) identity:**
  - **Pairing:** the signed-in owner calls a `pair-host` Edge Function. It creates a `hosts` row and a single-use pairing code. The connector redeems the code for a host credential through the same function.
  - **Least privilege:**
    - Each host is its own Supabase Auth user, with a `role = host` claim through a custom access-token hook.
    - RLS limits it to rows where `host_id` equals its own ID.
  - **Revocation:** deleting the host disables that user. Short JWT lifetimes bound how long Realtime keeps the cached grant.
  - The connector stores its refresh token in the OS credential store if one is available, and otherwise in a file only the user can read.
  - **[Unverified]** End-to-end behaviour of this pairing flow, and the details of the custom-claims hook.
- **Live updates:** the connector writes `sessions` and `session_events` rows. Clients subscribe to Postgres Changes, which RLS filters to the owner's rows.
- **Commands:**
  - **Send:** the client inserts a `commands` row. A unique `(owner_id, idempotency_key)` constraint stops a timed-out retry from creating a second command.
  - **Receive:** the connector subscribes to commands for its own `host_id` and updates `status`. The possible values are `queued`, `delivered`, `failed` and `rejected_by_policy`.
  - **Honest delivery:** clients never see "delivered" unless the connector wrote it.
- **Push:**
  - **Trigger:** a database webhook on `session_events` (status changes, deduplicated by a unique `dedupe_key`) calls a `notify` Edge Function.
  - **Web Push:** uses VAPID keys stored as **that project's** function secrets. They are generated per user and never shared.
  - **Expo push (future):** posts to Expo's push service using the device's Expo push token. **[Unverified]** whether a per-user project can send to the developer's Expo app without the developer's Expo access token. It depends on whether "enhanced push security" is enabled on the Expo project.
- **Heartbeat and "disconnected" state:**
  - The connector updates `hosts.last_seen_at` every 30 seconds.
  - A `pg_cron` job (or a check run when clients read) marks hosts disconnected once the threshold passes.
  - It records a `host_disconnected` event, which triggers a push.
  - **[Unverified]** pg_cron's availability and limits on the free tier.

**Developer's ongoing responsibilities and costs**

| Item | Cost |
|---|---|
| Static web app hosting (Cloudflare Pages, Netlify, Vercel free tiers) | About $0 |
| Domain (optional) | About $10–15 a year |
| Expo / EAS builds, Apple Developer ($99 a year), Google Play ($25 one-off) | Only when native apps ship |
| Database, Realtime, push delivery, per-user compute | **$0, paid by each user** |
| Shipping and maintaining migrations and Edge Function code for every schema version in the wild | Engineering time (see section 6) |

**User's costs:** free tier, with the pausing caveat below, or $25+ a month for Pro.

## 5. Option B: BYOS plus a developer-hosted relay

The connector and clients talk to a thin Node relay run by the developer. The relay reads and writes the user's Supabase project and sends push notifications.

**Why you might still want a relay:**
- **[Inference]** One Node/TypeScript runtime for server-side business logic, so the `domain` package runs unchanged instead of being split across SQL, RLS and Deno.
- A single, stable, versioned REST + SSE API for web and React Native, with an OpenAPI contract.
- Central control of Expo push credentials.
- A fallback if a corporate network blocks `*.supabase.co` WebSockets but allows the relay's domain.

**Why it undermines BYOS:**
- To act on a user's project server-side, the relay must hold **each user's secret key or a Management API token**. The developer then runs a concentrated store of privileged credentials, which is the highest-value target in the whole system. That is worse security than direct BYOS, not better.
- It brings back developer hosting costs: roughly $5–20 a month for a small always-on instance, plus monitoring, TLS and incident response. It also brings back operational responsibility for availability, the very thing BYOS was meant to remove.
- Every user's session metadata passes through developer infrastructure. That matters for this user's company-policy question.

**A safer form of B:** the relay holds **no** Supabase credentials. It only forwards end-to-end-authenticated messages, with clients still talking to Supabase directly for data. This is effectively Option A plus a WebSocket proxy. It only earns its place if direct `*.supabase.co` connections are blocked on target networks. **[Unverified]** On the current office network, outbound HTTPS to the major hosting providers works, there's no proxy, and certificates are issued by public CAs. `*.supabase.co` and WSS upgrades were **not** tested because no project exists.

## 6. Schema installation, migrations, updates, rollback

Every user runs their own copy of the schema at their own pace, so versioning is the core problem.

**How a user installs the schema, in recommended order:**
1. **Supabase CLI through `npx supabase`.** It's an npm package, needs no admin rights, and is compatible with a managed laptop.
   - The user runs `supabase link --project-ref …` and then `supabase db push`, applying the versioned SQL in `supabase/migrations/` from this repo.
   - Functions are deployed with `supabase functions deploy` and secrets set with `supabase secrets set`.
   - The user can review the SQL before applying it, which is the explicit approval step.
2. **Pasting a single SQL bundle into the Dashboard SQL editor.** This works but is error-prone, and Edge Functions still need the CLI or Dashboard.
3. **An automated OAuth app that provisions projects and applies migrations.** **Not recommended.**
   - The developer must register an OAuth app and run a backend that holds the client secret plus every user's refresh token.
   - The documented scopes don't clearly cover running SQL.
   - The database password can't be fetched through the API.
   - It reintroduces the hosted backend and the privileged-credential risk that BYOS was meant to avoid.

**Versioning rules**
- A `public.app_meta(schema_version int, applied_at timestamptz)` table records the installed version.
- Each client release declares `minSchema` and `maxSchema` in `packages/contracts`.
- On sign-in the client reads `schema_version`. If it's outside the client's supported range, the app shows a clear "your project needs migration N" screen and does not try to work in a degraded mode.
- **Migrations are expand-then-contract only.** A release may add columns or tables. Removals wait until clients no longer read them, so older apps and connectors keep working against newer schemas.
- **Rollback:**
  - Each migration ships with a reviewed down script.
  - In practice we fix forward.
  - The free tier has **no backups**, so the migration guide tells the user to `supabase db dump` before every upgrade.
- Edge Functions are versioned with the schema and check `app_meta` at runtime.

## 7. Security risks specific to BYOS

| Risk | Mitigation |
|---|---|
| User leaves Realtime "Allow public access" on, so channels can be read without auth | Use Postgres Changes, which respect RLS, for all data. Use Broadcast only on private channels. The setup checklist and an in-app health check verify the setting. **[Unverified]** whether the setting can be read through the API. |
| User changes our RLS policies or grants | Out of our control. An in-app health check runs read probes as `anon`, which should all fail, and reports drift. |
| Secret key leaked through a misconfigured client build | Clients take only URL plus publishable key. Supabase also rejects secret-key requests from browsers. |
| Cached Realtime grants survive a host or device revocation | Short JWT expiry (for example 10–15 minutes). Revocation disables the auth user, so the next refresh fails. |
| Commands replayed or duplicated | Unique idempotency key, an expiry time on commands, and the connector refuses expired or already-processed commands. |
| Metadata leaking sensitive project names or paths | Upload only aliased project names by default. Full paths are opt-in. |
| Free project paused after about 7 days of low activity (for example, laptop off over a holiday) | The app detects that the project is unreachable and shows "project paused – unpause in Supabase dashboard". **[Unverified]** whether connector heartbeats count as enough activity. The docs say "a few user requests to the database each day" is typically enough. |
| No backups on the free tier | Document export before migrations. Recommend Pro for anyone who cares about history. |
| Company policy: Remote Control disabled by the org | BYOS **does not change this**. Uploading even metadata to a personal cloud project should be cleared with IT or the Claude admin first. Remote commands stay disabled while the policy flag is false. |

## 8. Onboarding complexity (direct BYOS)

The user would need to:
1. Create a Supabase account and project.
2. Run `npx supabase login`, `link` and `db push` after reviewing the migration SQL.
3. Deploy the Edge Functions and set the VAPID and pairing secrets.
4. Turn off Realtime public access.
5. Configure Auth: redirect URLs, plus SMTP for a real email login.
6. Enter the project URL and publishable key in the web app, then sign in.
7. Pair the laptop connector.

That is realistic for developers, but too much for non-technical users. Steps 2–4 can be wrapped in one interactive `tavro setup-supabase` command that shows each change and asks before applying it. That makes it about a 10-minute setup for a developer.

## 9. Comparison and recommendation

| | Self-hosted API (current plan) | **A: Direct BYOS** | B: BYOS + relay |
|---|---|---|---|
| Developer infrastructure cost | One server + Postgres, about $5–25 a month, grows with users | **About $0** (static hosting) | $5–20+ a month, plus holding user credentials |
| Privileged secrets held by the developer | DB credentials for everyone's data | **None** | Every user's secret key or token (high risk) |
| Onboarding | Sign up | 7 steps (section 8), developer-level | Similar to A, plus linking to the relay |
| Business logic location | Node (`domain` package), all in one place | Split: `domain` in clients and connector, rules duplicated in SQL/RLS and Deno functions | Node |
| Migration burden | One database, developer controlled | **Many databases on different versions** | Many databases |
| Works fully offline/local | Yes | Yes, with `supabase start` in Docker | Yes (local) |
| React Native support | Same REST + SSE | `@supabase/supabase-js` works in React Native | Same REST + SSE |
| Free-tier pitfalls | n/a | Pausing, no backups, 2 projects | Same as A |

**Recommendation (for your review, not yet approved):**

1. **Prefer direct BYOS (A) over B.** If the goal is to minimise per-user cost, B undoes that goal and adds a credential store.
2. **Choose one backend for the MVP, not two.** Supporting both the Fastify/Postgres API and BYOS would double the persistence and auth work. If you choose BYOS:
   - Local development uses **`supabase start`**: the full Supabase stack in Docker, with no cloud and no admin rights.
   - That **replaces** the planned Fastify + Drizzle API.
   - The same migrations later deploy to the user's own project.
   - Tests run against the local stack, and authorisation-boundary tests become RLS tests.
3. **Keep the shared TypeScript layers either way:**
   - `packages/contracts`: Zod schemas for rows, events and commands.
   - `packages/domain`: state transitions, deduplication and authorisation rules. It stays pure TypeScript, so the web app, the connector, Deno Edge Functions and React Native can all import it.
   - `packages/api-client`: in BYOS, a typed wrapper over `supabase-js`. The web app and React Native share it, and only secure token storage is platform-specific: web storage on the web, SecureStore on mobile.
4. **Don't build** the OAuth-based automated provisioning.
5. **Hold any cloud use**, including BYOS with metadata only, until the company-policy question is answered. Local development needs no cloud.

**Open items to verify before implementing:**
- Run `supabase start` on this laptop: Docker resource use and whether corporate controls allow pulling the images.
- Connector JWT refresh and Realtime reconnect behaviour.
- The custom-claims hook for the host role.
- pg_cron on the free tier.
- Expo push from per-user projects.
- Whether heartbeats prevent pausing.
- WSS reachability of `*.supabase.co` from the office network.

## Sources

- [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
- [Supabase pricing](https://supabase.com/pricing)
- [Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Build a Supabase OAuth integration](https://supabase.com/docs/guides/integrations/build-a-supabase-integration)
- [OAuth app scopes](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)
