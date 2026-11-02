-- Fix: hosts could not insert sessions at all.
--
-- v1's set_owner_from_host checked `tg_table_name in (...) and not exists
-- (... new.session_id ...)`. PL/pgSQL resolves every record field in an
-- expression before evaluating it, so `and` does not short-circuit the
-- reference: on `sessions`, which has no session_id column, every insert
-- (including the connector's upsert) failed with 42703
-- `record "new" has no field "session_id"`. Found by the SQL-level tests
-- (supabase/sql-tests); `test:db` would have failed on its first session insert.
--
-- Function body only: same signature, owner and privileges (create or replace
-- keeps them), no change to tables or the client contract, so the schema
-- version stays 3. A new migration rather than an edit to v1, so projects
-- that already applied v1 get the fix too.

create or replace function public.set_owner_from_host() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select h.owner_id into new.owner_id from public.hosts h where h.id = new.host_id;
  if new.owner_id is null then
    raise exception 'unknown host' using errcode = '23503';
  end if;
  -- Nested, not "and": sessions rows have no session_id to resolve.
  if tg_table_name in ('session_events', 'session_messages') then
    if not exists (
      select 1 from public.sessions s where s.id = new.session_id and s.host_id = new.host_id
    ) then
      raise exception 'session does not belong to host' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
