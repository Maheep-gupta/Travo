-- Tavro schema v1.
--
-- Security model (see docs/SECURITY.md):
--   * Two kinds of authenticated principals:
--       owner : a normal Supabase Auth user (the person using the dashboard)
--       host  : a Supabase Auth user created by the pair-host Edge Function,
--               with app_metadata {"mc_role":"host","host_id":<uuid>}.
--     app_metadata can only be written with the secret key, never by clients.
--   * Every table has RLS enabled. Privileges are revoked from anon and
--     authenticated and then granted back per table and per column.
--   * owner_id on host-written rows is set by trigger from the host record,
--     so a host cannot attribute data to another owner.
--   * This migration does NOT change the project's default privileges, so it
--     does not affect tables the project owner creates outside this schema.

-- ---------------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------------
create table public.app_meta (
  id boolean primary key default true check (id),
  schema_version integer not null,
  updated_at timestamptz not null default now()
);
insert into public.app_meta (schema_version) values (1);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.hosts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  platform text check (char_length(platform) <= 50),
  connector_version text check (char_length(connector_version) <= 50),
  remote_control_allowed boolean,
  last_seen_at timestamptz,
  paired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index hosts_owner_idx on public.hosts (owner_id);

create table public.host_pairings (
  host_id uuid primary key references public.hosts (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  provider text not null check (provider in ('mock', 'claude-code', 'claude-desktop', 'cowork', 'claude-web')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  title text check (char_length(title) <= 300),
  project_label text check (char_length(project_label) <= 200),
  status text not null check (status in ('running', 'waiting_for_input', 'approval_required', 'completed', 'failed', 'ended', 'unknown')),
  status_reason text check (char_length(status_reason) <= 500),
  status_source text not null check (status_source in ('cli_agents_list', 'hook', 'transcript', 'mock', 'derived')),
  last_activity_at timestamptz,
  last_event_summary text check (char_length(last_event_summary) <= 500),
  capabilities text[] not null default '{}'
    check (capabilities <@ array['discover', 'get_details', 'read_messages', 'subscribe_events', 'send_message', 'resume', 'approve_requests']),
  is_demo boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (host_id, provider, external_id)
);
create index sessions_owner_idx on public.sessions (owner_id);

create table public.session_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  type text not null check (type in ('session_discovered', 'status_changed', 'session_ended')),
  status text check (status in ('running', 'waiting_for_input', 'approval_required', 'completed', 'failed', 'ended', 'unknown')),
  summary text check (char_length(summary) <= 500),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  is_demo boolean not null default false,
  occurred_at timestamptz not null default now(),
  unique (session_id, dedupe_key)
);
create index session_events_session_idx on public.session_events (session_id, occurred_at desc);
create index session_events_owner_idx on public.session_events (owner_id);

-- Transcript excerpts. The connector only writes these to a loopback database
-- (enforced client-side in packages/domain/content-guard.ts).
create table public.session_messages (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  external_uuid text not null check (char_length(external_uuid) between 1 and 100),
  role text not null check (role in ('user', 'assistant', 'system')),
  text text not null check (char_length(text) <= 4000),
  occurred_at timestamptz,
  unique (session_id, external_uuid)
);
create index session_messages_session_idx on public.session_messages (session_id, occurred_at);
create index session_messages_owner_idx on public.session_messages (owner_id);

create table public.notification_prefs (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  on_waiting_for_input boolean not null default true,
  on_approval_required boolean not null default true,
  on_completed boolean not null default true,
  on_failed boolean not null default true,
  on_host_disconnected boolean not null default true,
  on_host_reconnected boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------

-- host_id claimed in the JWT's app_metadata (server-controlled), or null.
create function public.jwt_host_id() returns uuid
language sql stable set search_path = '' as $$
  select case
    when (auth.jwt() -> 'app_metadata' ->> 'mc_role') = 'host'
     and (auth.jwt() -> 'app_metadata' ->> 'host_id') ~ '^[0-9a-f-]{36}$'
    then (auth.jwt() -> 'app_metadata' ->> 'host_id')::uuid
  end
$$;

-- The caller's host id if it is a paired, non-revoked host; otherwise null.
-- Re-checks the hosts table so revocation takes effect without waiting for
-- the JWT to expire.
create function public.active_host_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select h.id from public.hosts h
  where h.id = public.jwt_host_id()
    and h.auth_user_id = auth.uid()
    and h.revoked_at is null
$$;

-- The caller's user id if it is an owner (not a host); otherwise null.
create function public.owner_uid() returns uuid
language sql stable set search_path = '' as $$
  select case when public.jwt_host_id() is null then auth.uid() end
$$;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- Host-written rows inherit owner_id from the host; it cannot be supplied.
create function public.set_owner_from_host() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select h.owner_id into new.owner_id from public.hosts h where h.id = new.host_id;
  if new.owner_id is null then
    raise exception 'unknown host' using errcode = '23503';
  end if;
  if tg_table_name in ('session_events', 'session_messages') and not exists (
    select 1 from public.sessions s where s.id = new.session_id and s.host_id = new.host_id
  ) then
    raise exception 'session does not belong to host' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger sessions_set_owner before insert on public.sessions
  for each row execute function public.set_owner_from_host();
create trigger session_events_set_owner before insert on public.session_events
  for each row execute function public.set_owner_from_host();
create trigger session_messages_set_owner before insert on public.session_messages
  for each row execute function public.set_owner_from_host();

create function public.sessions_guard_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id
     or new.host_id is distinct from old.host_id
     or new.provider is distinct from old.provider
     or new.external_id is distinct from old.external_id then
    raise exception 'immutable session columns' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger sessions_guard_update before update on public.sessions
  for each row execute function public.sessions_guard_update();

-- Revocation is one-way.
create function public.hosts_guard_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'host revocation cannot be undone' using errcode = '42501';
  end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'immutable host columns' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger hosts_guard_update before update on public.hosts
  for each row execute function public.hosts_guard_update();

-- ---------------------------------------------------------------------------
-- Privileges: revoke everything, then grant the minimum.
-- ---------------------------------------------------------------------------
revoke all on public.app_meta, public.hosts, public.host_pairings, public.sessions,
  public.session_events, public.session_messages, public.notification_prefs
  from anon, authenticated;

grant select on public.app_meta to anon, authenticated;
grant select on public.hosts to authenticated;
grant update (name, revoked_at) on public.hosts to authenticated;
grant select on public.sessions to authenticated;
grant insert (host_id, provider, external_id, title, project_label, status, status_reason, status_source,
  last_activity_at, last_event_summary, capabilities, is_demo, started_at, ended_at)
  on public.sessions to authenticated;
grant update (title, project_label, status, status_reason, status_source, last_activity_at,
  last_event_summary, capabilities, is_demo, started_at, ended_at)
  on public.sessions to authenticated;
grant select on public.session_events to authenticated;
grant insert (host_id, session_id, type, status, summary, dedupe_key, is_demo, occurred_at)
  on public.session_events to authenticated;
grant select on public.session_messages to authenticated;
grant insert (host_id, session_id, external_uuid, role, text, occurred_at)
  on public.session_messages to authenticated;
grant select on public.notification_prefs to authenticated;
grant insert (owner_id, on_waiting_for_input, on_approval_required, on_completed, on_failed,
  on_host_disconnected, on_host_reconnected, updated_at) on public.notification_prefs to authenticated;
grant update (on_waiting_for_input, on_approval_required, on_completed, on_failed,
  on_host_disconnected, on_host_reconnected, updated_at) on public.notification_prefs to authenticated;
-- host_pairings: no client access at all.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.app_meta enable row level security;
alter table public.hosts enable row level security;
alter table public.host_pairings enable row level security;
alter table public.sessions enable row level security;
alter table public.session_events enable row level security;
alter table public.session_messages enable row level security;
alter table public.notification_prefs enable row level security;

create policy app_meta_read on public.app_meta for select to anon, authenticated using (true);

create policy hosts_owner_read on public.hosts for select to authenticated
  using (owner_id = (select public.owner_uid()));
create policy hosts_self_read on public.hosts for select to authenticated
  using (id = (select public.active_host_id()));
create policy hosts_owner_update on public.hosts for update to authenticated
  using (owner_id = (select public.owner_uid()))
  with check (owner_id = (select public.owner_uid()));

create policy sessions_owner_read on public.sessions for select to authenticated
  using (owner_id = (select public.owner_uid()));
create policy sessions_host_read on public.sessions for select to authenticated
  using (host_id = (select public.active_host_id()));
create policy sessions_host_insert on public.sessions for insert to authenticated
  with check (host_id = (select public.active_host_id()));
create policy sessions_host_update on public.sessions for update to authenticated
  using (host_id = (select public.active_host_id()))
  with check (host_id = (select public.active_host_id()));

create policy events_owner_read on public.session_events for select to authenticated
  using (owner_id = (select public.owner_uid()));
create policy events_host_read on public.session_events for select to authenticated
  using (host_id = (select public.active_host_id()));
create policy events_host_insert on public.session_events for insert to authenticated
  with check (host_id = (select public.active_host_id()));

create policy messages_owner_read on public.session_messages for select to authenticated
  using (owner_id = (select public.owner_uid()));
create policy messages_host_read on public.session_messages for select to authenticated
  using (host_id = (select public.active_host_id()));
create policy messages_host_insert on public.session_messages for insert to authenticated
  with check (host_id = (select public.active_host_id()));

create policy prefs_owner_read on public.notification_prefs for select to authenticated
  using (owner_id = (select public.owner_uid()));
create policy prefs_owner_insert on public.notification_prefs for insert to authenticated
  with check (owner_id = (select public.owner_uid()));
create policy prefs_owner_update on public.notification_prefs for update to authenticated
  using (owner_id = (select public.owner_uid()))
  with check (owner_id = (select public.owner_uid()));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Owner starts pairing a new host. Returns a one-time code (shown once; only
-- its SHA-256 is stored) valid for 10 minutes.
create function public.create_host_pairing(p_name text)
returns table (host_id uuid, code text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := public.owner_uid();
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(12);
  v_code text := '';
  v_host uuid;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  if v_owner is null then
    raise exception 'only owners can pair hosts' using errcode = '42501';
  end if;
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) not between 1 and 100 then
    raise exception 'host name must be 1-100 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.hosts h
      where h.owner_id = v_owner and h.paired_at is null and h.revoked_at is null) >= 5 then
    raise exception 'too many pending pairings; revoke unused hosts first' using errcode = '54000';
  end if;
  for i in 0..11 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
    if i in (3, 7) then v_code := v_code || '-'; end if;
  end loop;
  insert into public.hosts (owner_id, name) values (v_owner, p_name) returning id into v_host;
  insert into public.host_pairings (host_id, code_hash, expires_at)
    values (v_host, encode(extensions.digest(v_code, 'sha256'), 'hex'), v_expires);
  return query select v_host, v_code, v_expires;
end
$$;

-- Service-role only: look up a valid, unused code (does not consume it).
create function public.peek_host_pairing(p_code text) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.host_id from public.host_pairings p
  join public.hosts h on h.id = p.host_id
  where p.code_hash = encode(extensions.digest(p_code, 'sha256'), 'hex')
    and p.used_at is null and p.expires_at > now()
    and h.revoked_at is null and h.auth_user_id is null
$$;

-- Service-role only: atomically consume the code and bind the host's auth user.
-- Returns false if the code was already used, expired or revoked meanwhile.
create function public.claim_host_pairing(p_code text, p_auth_user_id uuid, p_platform text, p_connector_version text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_host uuid;
begin
  update public.host_pairings p set used_at = now()
  where p.code_hash = encode(extensions.digest(p_code, 'sha256'), 'hex')
    and p.used_at is null and p.expires_at > now()
  returning p.host_id into v_host;
  if v_host is null then return false; end if;
  update public.hosts h set auth_user_id = p_auth_user_id, paired_at = now(),
    platform = left(p_platform, 50), connector_version = left(p_connector_version, 50)
  where h.id = v_host and h.auth_user_id is null and h.revoked_at is null;
  return found;
end
$$;

-- Host heartbeat: updates only the caller's own host row.
create function public.host_heartbeat(p_platform text, p_connector_version text, p_remote_control_allowed boolean)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_host uuid := public.active_host_id(); v_now timestamptz := now();
begin
  if v_host is null then
    raise exception 'not an active host' using errcode = '42501';
  end if;
  update public.hosts set last_seen_at = v_now, platform = left(p_platform, 50),
    connector_version = left(p_connector_version, 50), remote_control_allowed = p_remote_control_allowed
  where id = v_host;
  return v_now;
end
$$;

revoke execute on function public.jwt_host_id(), public.active_host_id(), public.owner_uid(),
  public.set_owner_from_host(), public.sessions_guard_update(), public.hosts_guard_update(),
  public.create_host_pairing(text), public.peek_host_pairing(text),
  public.claim_host_pairing(text, uuid, text, text), public.host_heartbeat(text, text, boolean)
  from public, anon, authenticated;
-- Helpers are evaluated inside RLS policies as the calling role.
grant execute on function public.jwt_host_id(), public.active_host_id(), public.owner_uid() to authenticated;
grant execute on function public.create_host_pairing(text), public.host_heartbeat(text, text, boolean) to authenticated;
grant execute on function public.peek_host_pairing(text), public.claim_host_pairing(text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Realtime (Postgres Changes respect the RLS policies above)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.hosts, public.sessions, public.session_events;
