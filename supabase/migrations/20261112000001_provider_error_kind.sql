-- Tavro schema v4: why a host's session source is failing (D-026).
--
-- v2 stored only *that* the source failed (provider_error_since), so every
-- failure read "source not responding". The connector already knows which of
-- a fixed set of categories applies (D-025); this stores that category so the
-- app can say what to do (install the CLI, sign in to it, ...).
--
-- provider_error_kind: null while the source is healthy; otherwise one of the
-- fixed categories below, or null for a failure reported by a pre-v4
-- connector. Only the category is stored: never a message, path or output.
-- Written ONLY by host_heartbeat (security definer). Owners keep their v1
-- column grant, update (name, revoked_at), so they can read this column (the
-- table-level SELECT grant) but not write it; hosts have no UPDATE on hosts.
-- hosts left the Realtime publication in 20261105000001 and isn't re-added.

alter table public.hosts add column provider_error_kind text
  constraint hosts_provider_error_kind_check check (provider_error_kind in (
    'cli_missing', 'auth_required', 'timeout', 'invalid_output',
    'incompatible_version', 'interrupted', 'failed', 'writes_not_applied'))
  -- A category describes a current failure, never a healthy source.
  constraint hosts_provider_error_kind_needs_since check (provider_error_kind is null or provider_error_since is not null);

-- Replace the v2 heartbeat. p_provider_error_kind defaults to null so a v3
-- connector's four-argument call (PostgREST matches by argument names) keeps
-- working through an upgrade: its failures store a null kind, which the app
-- shows with the generic message.
drop function public.host_heartbeat(text, text, boolean, boolean);

create function public.host_heartbeat(
  p_platform text,
  p_connector_version text,
  p_remote_control_allowed boolean,
  p_provider_ok boolean,
  p_provider_error_kind text default null
)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_host uuid := public.active_host_id(); v_now timestamptz := now();
begin
  if v_host is null then
    raise exception 'not an active host' using errcode = '42501';
  end if;
  if p_provider_ok is null then
    raise exception 'provider health is required' using errcode = '22004';
  end if;
  if p_provider_ok and p_provider_error_kind is not null then
    raise exception 'a healthy source has no error kind' using errcode = '22023';
  end if;
  -- Checked here too (not only by the constraint) for a clear error.
  if p_provider_error_kind is not null and p_provider_error_kind <> all (array[
      'cli_missing', 'auth_required', 'timeout', 'invalid_output',
      'incompatible_version', 'interrupted', 'failed', 'writes_not_applied']) then
    raise exception 'unknown provider error kind' using errcode = '22023';
  end if;
  update public.hosts set
    last_seen_at = v_now,
    platform = left(p_platform, 50),
    connector_version = left(p_connector_version, 50),
    remote_control_allowed = p_remote_control_allowed,
    -- Keep the original start of an ongoing failure; clear both on recovery.
    -- The category follows the latest report: a failure can change kind.
    provider_error_since = case when p_provider_ok then null else coalesce(provider_error_since, v_now) end,
    provider_error_kind = case when p_provider_ok then null else p_provider_error_kind end
  where id = v_host;
  return v_now;
end
$$;

revoke execute on function public.host_heartbeat(text, text, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.host_heartbeat(text, text, boolean, boolean, text) to authenticated;

update public.app_meta set schema_version = 4;
