-- Tavro schema v2: session source health.
--
-- A host can be reachable (heartbeating) while its session source — e.g. the
-- Claude Code CLI — is failing. Without this column the dashboard would keep
-- showing the last stored session statuses as if they were live.
--
-- provider_error_since: null while the source is healthy; otherwise when the
-- current failure began. Written ONLY by host_heartbeat (security definer).
-- No role has a column UPDATE grant for it: v1 grants owners update on
-- (name, revoked_at) only, and hosts have no direct update on hosts at all.

alter table public.hosts add column provider_error_since timestamptz;

-- Replace the heartbeat with a version that also reports source health.
drop function public.host_heartbeat(text, text, boolean);

create function public.host_heartbeat(
  p_platform text,
  p_connector_version text,
  p_remote_control_allowed boolean,
  p_provider_ok boolean
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
  update public.hosts set
    last_seen_at = v_now,
    platform = left(p_platform, 50),
    connector_version = left(p_connector_version, 50),
    remote_control_allowed = p_remote_control_allowed,
    -- Keep the original start of an ongoing failure; clear on recovery.
    provider_error_since = case when p_provider_ok then null else coalesce(provider_error_since, v_now) end
  where id = v_host;
  return v_now;
end
$$;

revoke execute on function public.host_heartbeat(text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.host_heartbeat(text, text, boolean, boolean) to authenticated;

update public.app_meta set schema_version = 2;
