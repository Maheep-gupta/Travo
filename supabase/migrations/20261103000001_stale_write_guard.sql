-- Tavro schema v3: out-of-order session writes (spec 4.2 "newer wins").
--
-- A session write can reach the database after a newer one: two connector
-- processes for the same host overlapping during a restart, a request held by
-- a proxy and committed after its retry, or a host clock that stepped back.
-- Without a guard the late write would put an old status back on the
-- dashboard as if it were live.
--
-- observed_at: when the connector observed the values it is writing. Rules:
--   * required on every write (a null is rejected, never defaulted);
--   * clamped to now() + 5 minutes, so one fast host clock cannot pin a
--     session for longer than that once the clock is corrected;
--   * an UPDATE whose observed_at is older than the stored one is SKIPPED
--     (the trigger returns null): no error, no new row version, no realtime
--     change, and the row is absent from RETURNING. Rejecting instead would
--     fail the connector's whole batch over one late row and make it report
--     the backend as offline;
--   * an equal observed_at is applied, so an identical retry is a no-op in
--     effect. An UPDATE that omits observed_at keeps the stored value and so
--     counts as equal; the connector always sends it.
-- Existing rows get -infinity ("observed before any real observation"), so
-- the first v3 write always wins.
--
-- Owners still cannot write sessions: RLS allows inserts/updates only from the
-- active host that owns the row, and sessions_guard_update keeps its checks.

alter table public.sessions add column observed_at timestamptz not null default '-infinity';
-- No default from now on: a write without an observation time is an error.
alter table public.sessions alter column observed_at drop default;

-- Runs before sessions_guard_update (triggers fire in name order), so the
-- staleness comparison there sees the clamped value.
create function public.sessions_bound_observed_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- least() ignores nulls, so check first or a null would become now() + 5 min.
  if new.observed_at is null then
    raise exception 'observed_at is required' using errcode = '23502';
  end if;
  new.observed_at := least(new.observed_at, now() + interval '5 minutes');
  return new;
end
$$;
create trigger sessions_bound_observed_at before insert or update on public.sessions
  for each row execute function public.sessions_bound_observed_at();

-- Same checks as v1, plus the stale-write skip. CREATE OR REPLACE keeps the
-- function's owner and its revoked EXECUTE privileges.
create or replace function public.sessions_guard_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Checked before staleness, so a forged move is an error even when stale.
  if new.owner_id is distinct from old.owner_id
     or new.host_id is distinct from old.host_id
     or new.provider is distinct from old.provider
     or new.external_id is distinct from old.external_id then
    raise exception 'immutable session columns' using errcode = '42501';
  end if;
  if new.observed_at < old.observed_at then
    return null; -- an older observation never overwrites a newer one
  end if;
  new.updated_at := now();
  return new;
end
$$;

revoke execute on function public.sessions_bound_observed_at() from public, anon, authenticated;

grant insert (observed_at), update (observed_at) on public.sessions to authenticated;
-- PostgREST's merge-duplicates upsert sets every payload column on conflict,
-- including the conflict key (host_id, provider, external_id), and Postgres
-- requires UPDATE privilege on each. v1 never granted these, so a connector's
-- second upsert of a row would fail with 42501. Granting them is safe:
-- sessions_guard_update rejects any change to them, and RLS still limits
-- writes to the row's own active host.
grant update (host_id, provider, external_id) on public.sessions to authenticated;

update public.app_meta set schema_version = 3;
