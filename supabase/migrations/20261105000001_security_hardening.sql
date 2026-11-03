-- Security hardening from the 2026-11-03 review (findings S2, S3, S4, M5).
--
-- S4  owner_uid() failed open: a token whose app_metadata names mc_role but
--     carries a malformed host_id was treated as an owner. Any mc_role claim
--     now means "not an owner"; jwt_host_id() accepts only a well-formed uuid.
-- S3  sessions.capabilities accepted control capabilities (send_message,
--     resume, approve_requests). While D-003 stands no adapter has them, so a
--     stolen host credential could only use them to make the UI offer control.
--     The check now allows read-only capabilities only.
-- S2  Transcript storage was granted to hosts on every project, so D-004
--     ("transcripts only to a loopback database") rested on the connector
--     alone. Inserts into session_messages now also require
--     app_meta.transcripts_enabled, which defaults to false and which no API
--     role can change. Only the local stack's seed.sql turns it on; hosted
--     projects follow the runbook (`db push`, no seed) and never do.
-- M5  Realtime: clients subscribe on a private channel to INSERT/UPDATE on
--     sessions and session_events only. hosts leaves the publication (host
--     heartbeats every 30 s would otherwise wake every client; the host list
--     is polled). A minimal realtime.messages policy lets owners join that
--     private channel and lets nobody send on it.
--
-- Clients read and write the same columns as before (the new app_meta column
-- is read by nobody but RLS), so the schema version stays 3 (see D-022).
-- New migration rather than edits to
-- v1-v3, so projects that already applied them get the fixes too.

-- ---------------------------------------------------------------------------
-- S4: identity helpers fail closed. CREATE OR REPLACE keeps owners and the
-- v1 grants (execute to authenticated only); the SQL tests assert them.
-- ---------------------------------------------------------------------------
create or replace function public.jwt_host_id() returns uuid
language sql stable set search_path = '' as $$
  select case
    when (auth.jwt() -> 'app_metadata' ->> 'mc_role') = 'host'
     and (auth.jwt() -> 'app_metadata' ->> 'host_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (auth.jwt() -> 'app_metadata' ->> 'host_id')::uuid
  end
$$;

-- Null for any token whose server-set app_metadata has an mc_role key at all,
-- whatever its value and whether or not its host_id is usable. Only
-- app_metadata counts: user_metadata is user-writable and grants nothing.
create or replace function public.owner_uid() returns uuid
language sql stable set search_path = '' as $$
  select case
    when coalesce((auth.jwt() -> 'app_metadata') ? 'mc_role', false) then null
    else auth.uid()
  end
$$;

-- ---------------------------------------------------------------------------
-- S3: read-only capabilities only (D-003). Rows written under the wider v1
-- check lose their control capabilities first, so the new check validates.
-- ---------------------------------------------------------------------------
update public.sessions
  set capabilities = array(
    select c from unnest(capabilities) with ordinality as t(c, n)
    where c <> all (array['send_message', 'resume', 'approve_requests'])
    order by n)
  where capabilities && array['send_message', 'resume', 'approve_requests'];

alter table public.sessions drop constraint sessions_capabilities_check;
alter table public.sessions add constraint sessions_capabilities_check
  check (capabilities <@ array['discover', 'get_details', 'read_messages', 'subscribe_events']);

-- ---------------------------------------------------------------------------
-- S2: transcript storage is opt-in at the database.
-- ---------------------------------------------------------------------------
-- Readable like the rest of app_meta (anon may learn whether this project
-- stores transcripts; it learns no content). No role has INSERT or UPDATE on
-- app_meta (v1 revoked all from anon and authenticated, then granted SELECT
-- only), so only the database owner or the secret key can change it.
alter table public.app_meta add column transcripts_enabled boolean not null default false;

drop policy messages_host_insert on public.session_messages;
-- A missing app_meta row yields null, which a WITH CHECK treats as a refusal.
create policy messages_host_insert on public.session_messages for insert to authenticated
  with check (
    host_id = (select public.active_host_id())
    and (select m.transcripts_enabled from public.app_meta m where m.id)
  );

-- ---------------------------------------------------------------------------
-- M5: Realtime.
-- ---------------------------------------------------------------------------
-- Nothing subscribes to hosts any more. session_messages was never published
-- and stays out. Guarded: dropping a table that isn't published is an error,
-- and an operator may already have removed hosts by hand (Dashboard toggle).
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hosts'
  ) then
    alter publication supabase_realtime drop table public.hosts;
  end if;
end
$$;

-- Joining a private channel is authorised by RLS on realtime.messages. This
-- policy only lets signed-in owners (never hosts or anon) receive on topics
-- named `tavro-changes:<anything>`. There is deliberately no INSERT policy:
-- no client can broadcast or track presence there, so the topic carries
-- nothing but the Postgres Changes each subscriber's own table RLS allows.
-- Any future Broadcast use must add per-owner topics, not widen this.
create policy tavro_changes_owner_receive on realtime.messages for select to authenticated
  using (
    (select public.owner_uid()) is not null
    and (select realtime.topic()) like 'tavro-changes:%'
    and extension in ('broadcast', 'presence')
  );
