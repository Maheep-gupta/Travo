// SQL-level (PGlite) test harness — NOT a substitute for `npm run test:db`.
// It runs the real migrations on Postgres compiled to WASM, behind a minimal
// Supabase shim (supabase-shim.sql lists how that differs from Supabase).
// PostgREST, GoTrue, Realtime and the pair-host Edge Function are not involved.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Migration files in the order the Supabase CLI applies them (filename order). */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

/** Applies one migration file, unmodified. */
export async function applyMigration(pg: PGlite, file: string): Promise<void> {
  try {
    await pg.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  } catch (e) {
    throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
  }
}

/** A new in-memory database: the shim, then `files` (default: every migration). */
export async function freshDatabase(files: string[] = migrationFiles()): Promise<PGlite> {
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await pg.exec(readFileSync(`${here}supabase-shim.sql`, "utf8"));
  for (const file of files) await applyMigration(pg, file);  return pg;
}

export type Principal =
  | { role: "anon" }
  | { role: "service_role" }
  | { role: "authenticated"; claims: Record<string, unknown> };

export const anon: Principal = { role: "anon" };
export const serviceRole: Principal = { role: "service_role" };

/** Claims GoTrue issues for a normal user. */
export function ownerPrincipal(userId: string): Principal {
  return {
    role: "authenticated",
    claims: { sub: userId, role: "authenticated", aal: "aal1", app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {} },
  };
}

/** Claims for a host user created by pair-host (server-set app_metadata). */
export function hostPrincipal(authUserId: string, hostId: string): Principal {
  return {
    role: "authenticated",
    claims: {
      sub: authUserId,
      role: "authenticated",
      aal: "aal1",
      app_metadata: { provider: "email", providers: ["email"], mc_role: "host", host_id: hostId },
      user_metadata: {},
    },
  };
}

/**
 * Runs statements as `who`, in one transaction, the way PostgREST does: the
 * role and the claims are set transaction-locally with set_config before the
 * request's SQL. Returns the last statement's rows. Throws the database error
 * (with its SQLSTATE in `code`) and rolls back on failure.
 */
export async function as<T = Record<string, unknown>>(
  pg: PGlite,
  who: Principal,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return pg.transaction(async (tx: Transaction) => {
    const claims = who.role === "authenticated" ? who.claims : { role: who.role };
    await tx.query("select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)", [who.role, JSON.stringify(claims)]);
    return (await tx.query<T>(sql, params)).rows;
  });
}

/** Applies supabase/seed.sql as the superuser, as `supabase db reset` does on the local stack. */
export async function applySeed(pg: PGlite): Promise<void> {
  await pg.exec(readFileSync(fileURLToPath(new URL("../seed.sql", import.meta.url)), "utf8"));
}

/**
 * Emulates Realtime's private-channel authorization for `who` on `topic`: a
 * row for each extension is present (as Realtime inserts one in its check
 * transaction), and the caller may receive if a SELECT with `realtime.topic`
 * set finds it, and may send if its own INSERT passes RLS. An emulation of
 * the policy decision only, not of the Realtime service.
 */
export async function realtimeAccess(
  pg: PGlite,
  who: Principal,
  topic: string,
): Promise<{ broadcast: boolean; presence: boolean; send: boolean }> {
  let result: { broadcast: boolean; presence: boolean; send: boolean } | undefined;
  const ROLLBACK = new Error("rollback");
  await pg
    .transaction(async (tx: Transaction) => {
      await tx.query("insert into realtime.messages (topic, extension) values ($1, 'broadcast'), ($1, 'presence')", [topic]);
      const claims = who.role === "authenticated" ? who.claims : { role: who.role };
      await tx.query(
        "select set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('realtime.topic', $3, true)",
        [who.role, JSON.stringify(claims), topic],
      );
      const { rows } = await tx.query<{ extension: string }>("select extension from realtime.messages where topic = $1", [topic]);
      let send = true;
      await tx.query("savepoint s");
      try {
        await tx.query("insert into realtime.messages (topic, extension, event) values ($1, 'broadcast', 'x')", [topic]);
      } catch {
        send = false;
        await tx.query("rollback to savepoint s");
      }
      result = { broadcast: rows.some((r) => r.extension === "broadcast"), presence: rows.some((r) => r.extension === "presence"), send };
      throw ROLLBACK; // leave nothing behind, as Realtime's check does
    })
    .catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
  if (!result) throw new Error("realtime access check did not run");
  return result;
}

/** The SQLSTATE and message of a failed call, or null if it succeeded. */
export async function failure(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? "?", message: err.message ?? String(e) };
  }
}

/** Stands in for GoTrue creating a user (test setup only, as the superuser). */
export async function createAuthUser(pg: PGlite, appMetadata: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await pg.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [id, `${id}@test.local`, JSON.stringify(appMetadata)]);
  return id;
}

export interface Owner {
  id: string;
  who: Principal;
}

export interface Host {
  id: string;
  authUserId: string;
  who: Principal;
}

export async function createOwner(pg: PGlite): Promise<Owner> {
  const id = await createAuthUser(pg, { provider: "email", providers: ["email"] });
  return { id, who: ownerPrincipal(id) };
}

export async function startPairing(pg: PGlite, owner: Owner, name = "Test laptop"): Promise<{ host_id: string; code: string }> {
  const [row] = await as<{ host_id: string; code: string }>(pg, owner.who, "select * from public.create_host_pairing($1)", [name]);
  if (!row) throw new Error("no pairing row");
  return row;
}

/**
 * The pair-host Edge Function's database steps, in its order: peek the code
 * (service role), create the host's auth user with server-set app_metadata,
 * then claim. The HTTP layer and its error mapping are not exercised.
 */
export async function redeem(pg: PGlite, code: string): Promise<Host | null> {
  const [peek] = await as<{ host_id: string | null }>(pg, serviceRole, "select public.peek_host_pairing($1) as host_id", [code]);
  const hostId = peek?.host_id;
  if (!hostId) return null;
  const authUserId = await createAuthUser(pg, { provider: "email", providers: ["email"], mc_role: "host", host_id: hostId });
  const [claim] = await as<{ ok: boolean }>(pg, serviceRole, "select public.claim_host_pairing($1, $2, $3, $4) as ok", [code, authUserId, "test", "0.0.0-test"]);
  if (!claim?.ok) {
    await pg.query("delete from auth.users where id = $1", [authUserId]);
    return null;
  }
  return { id: hostId, authUserId, who: hostPrincipal(authUserId, hostId) };
}

export async function pairHost(pg: PGlite, owner: Owner): Promise<Host> {
  const { code } = await startPairing(pg, owner);
  const host = await redeem(pg, code);
  if (!host) throw new Error("pairing failed");
  return host;
}

/** A connector-style session payload (helpers.ts `sessionRow`, same columns). */
export function sessionRow(externalId: string = randomUUID(), observed_at: string | null = new Date().toISOString()) {
  return {
    provider: "mock",
    external_id: externalId,
    title: "Test session",
    project_label: "proj",
    status: "running",
    status_reason: null,
    status_source: "mock",
    last_activity_at: new Date().toISOString(),
    last_event_summary: null,
    capabilities: ["discover"],
    is_demo: true,
    started_at: null,
    ended_at: null,
    observed_at,
  };
}

type Payload = Record<string, unknown>;

function columnsOf(rows: Payload[]): string[] {
  const cols = Object.keys(rows[0] ?? {});
  for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error(`bad column ${c}`);
  return cols;
}

/**
 * The statement shape PostgREST issues for `.insert(rows).select(...)`: the
 * JSON body is expanded with json_populate_recordset and only the payload's
 * columns are inserted (so column INSERT grants apply to exactly those).
 */
export function insertSql(table: string, rows: Payload[], returning = "*"): [string, unknown[]] {
  const cols = columnsOf(rows).join(", ");
  return [
    `insert into public.${table} (${cols}) select ${cols} from json_populate_recordset(null::public.${table}, $1::json) returning ${returning}`,
    [JSON.stringify(rows)],
  ];
}

/**
 * PostgREST's merge-duplicates upsert (`.upsert(rows, { onConflict })`): ON
 * CONFLICT DO UPDATE SET <every payload column> = EXCLUDED.<column>, including
 * the conflict key, which is why v3 grants UPDATE on it.
 */
export function upsertSql(table: string, rows: Payload[], onConflict: string, returning = "*"): [string, unknown[]] {
  const cols = columnsOf(rows);
  const [insert, params] = insertSql(table, rows, returning);
  const set = cols.map((c) => `${c} = excluded.${c}`).join(", ");
  return [insert.replace(" returning ", ` on conflict (${onConflict}) do update set ${set} returning `), params];
}

/** PostgREST's `ignoreDuplicates: true` upsert. */
export function upsertIgnoreSql(table: string, rows: Payload[], onConflict: string): [string, unknown[]] {
  const [insert, params] = insertSql(table, rows);
  return [insert.replace(" returning ", ` on conflict (${onConflict}) do nothing returning `), params];
}
