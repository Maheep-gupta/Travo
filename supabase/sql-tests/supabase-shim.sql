-- Minimal Supabase environment for the PGlite SQL-level tests.
--
-- SQL-level (PGlite) only — NOT a substitute for `npm run test:db`. Applied as
-- PGlite's `postgres` user before the real migrations, which run unmodified.
-- It recreates only what the migrations and the tests depend on, mirroring
-- the definitions in supabase/postgres (migrations/db/init-scripts and the
-- auth schema). Differences from a real Supabase project:
--
--   * `postgres` is a true superuser here; on Supabase it is not (the platform
--     keeps supabase_admin). Tests never act as `postgres` except to seed
--     auth.users, which stands in for GoTrue. Every client call switches role
--     first, so privileges and RLS apply to it. Security-definer functions run
--     as their owner (`postgres`), which owns the tables in both setups.
--   * Roles are NOLOGIN, with no `authenticator` role. Tests switch role from
--     the superuser the way PostgREST does after logging in as authenticator,
--     so role-membership checks for that switch are not exercised.
--   * auth.users has only the columns the migrations and tests need. GoTrue,
--     its triggers, token signing and expiry don't exist: tests write the JWT
--     claims directly, so "GoTrue only puts server-set app_metadata in tokens"
--     is assumed here, not tested.
--   * No PostgREST, Realtime, Storage or Edge Functions. Only the publication
--     the v1 migration alters is created; Realtime's RLS-filtered delivery is
--     not exercised.
--   * Postgres major version is PGlite's (18 at the time of writing), not the
--     project's Supabase image.

-- Roles (supabase/postgres init-scripts: 00000000000000-initial-schema.sql).
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to postgres, anon, authenticated, service_role;
-- Supabase grants everything on new public objects to the API roles by
-- default; the migrations depend on revoking these, so the shim must grant them.
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- Extensions live in their own schema on Supabase (migrations call
-- extensions.digest and extensions.gen_random_bytes). The test harness loads
-- PGlite's build of pgcrypto.
create schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension pgcrypto with schema extensions;

-- Realtime publication (created empty by Supabase; v1 adds tables to it).
create publication supabase_realtime;

-- Auth schema: only what the migrations reference.
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

-- No grants to the API roles, as on Supabase (clients use GoTrue, not this table).
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Same bodies as Supabase's auth helpers: they read the claims PostgREST sets
-- with set_config('request.jwt.claims', <json>, true).
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
