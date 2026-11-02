// SQL-level (PGlite) tests of the migrations — NOT a substitute for
// `npm run test:db`. They show what the SQL itself enforces (grants, RLS,
// triggers, RPCs) under a minimal Supabase shim; they do not exercise
// PostgREST, GoTrue, Realtime or the pair-host Edge Function. Cases mirror
// supabase/tests/rls.test.ts where the SQL alone can answer them.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anon,
  as,
  createAuthUser,
  createOwner,
  failure,
  freshDatabase,
  hostPrincipal,
  insertSql,
  migrationFiles,
  pairHost,
  redeem,
  sessionRow,
  startPairing,
  upsertIgnoreSql,
  upsertSql,
  type Host,
  type Owner,
  type Principal,
} from "./harness.js";

let pg: PGlite;
let ownerA: Owner;
let ownerB: Owner;
let hostA: Host;
let hostB: Host;
let sessionA: string;
let sessionB: string;

const KEY = "host_id, provider, external_id";
const ids = (rows: { id: unknown }[]) => rows.map((r) => r.id);

async function insertSession(host: Host, row: Record<string, unknown> = sessionRow()): Promise<string> {
  const [r] = await as<{ id: string }>(pg, host.who, ...insertSql("sessions", [{ host_id: host.id, ...row }], "id"));
  if (!r) throw new Error("no session row");
  return r.id;
}

function upsertAs(who: Principal, rows: Record<string, unknown>[], returning = "id, external_id, status") {
  return as<{ id: string; external_id: string; status: string }>(pg, who, ...upsertSql("sessions", rows, KEY, returning));
}

beforeAll(async () => {
  pg = await freshDatabase();
  ownerA = await createOwner(pg);
  ownerB = await createOwner(pg);
  hostA = await pairHost(pg, ownerA);
  hostB = await pairHost(pg, ownerB);
  sessionA = await insertSession(hostA);
  sessionB = await insertSession(hostB);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe("migrations", () => {
  it("apply in order on top of the shim and end at schema v3", async () => {
    expect(migrationFiles()).toEqual([
      "20261029000001_schema_v1.sql",
      "20261102000001_source_health.sql",
      "20261103000001_stale_write_guard.sql",
      "20261104000001_fix_set_owner_from_host.sql",
    ]);
    const [meta] = await as<{ schema_version: number }>(pg, anon, "select schema_version from public.app_meta");
    expect(meta?.schema_version).toBe(3);
  });

  it("publish hosts, sessions and events to Realtime, but never transcript messages", async () => {
    const rows = (await pg.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1")).rows;
    expect(rows.map((r) => r.tablename)).toEqual(["hosts", "session_events", "sessions"]);
  });

  it("enable RLS on every public table", async () => {
    const rows = (await pg.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'",
    )).rows;
    expect(rows.length).toBe(7);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });
});

describe("anonymous (publishable key only)", () => {
  it("can read the schema version and nothing else", async () => {
    for (const table of ["hosts", "sessions", "session_events", "session_messages", "notification_prefs", "host_pairings"]) {
      expect((await failure(as(pg, anon, `select * from public.${table}`)))?.code).toBe("42501");
    }
  });

  it("cannot call privileged RPCs or write", async () => {
    expect((await failure(as(pg, anon, "select * from public.create_host_pairing('x')")))?.code).toBe("42501");
    expect((await failure(as(pg, anon, "select public.peek_host_pairing('AAAA-AAAA-AAAA')")))?.code).toBe("42501");
    expect((await failure(as(pg, anon, "select public.claim_host_pairing('AAAA-AAAA-AAAA', $1, '', '')", [randomUUID()])))?.code).toBe("42501");
    expect((await failure(as(pg, anon, "select public.host_heartbeat('x', 'x', false, true)")))?.code).toBe("42501");
    expect((await failure(as(pg, anon, ...insertSql("sessions", [{ ...sessionRow(), host_id: hostA.id }]))))?.code).toBe("42501");
  });
});

describe("owner isolation", () => {
  it("owners see only their own hosts and sessions", async () => {
    expect(ids(await as(pg, ownerA.who, "select id from public.hosts"))).toEqual([hostA.id]);
    expect(ids(await as(pg, ownerA.who, "select id from public.sessions"))).toEqual([sessionA]);
    expect(await as(pg, ownerB.who, "select id from public.sessions where id = $1", [sessionA])).toEqual([]);
  });

  it("owners cannot write sessions or events", async () => {
    expect((await failure(as(pg, ownerA.who, ...insertSql("sessions", [{ ...sessionRow(), host_id: hostA.id }]))))?.code).toBe("42501");
    expect(await as(pg, ownerA.who, "update public.sessions set status = 'failed', observed_at = now() where id = $1 returning id", [sessionA])).toEqual([]);
    const ev = { host_id: hostA.id, session_id: sessionA, type: "status_changed", status: "failed", dedupe_key: "x" };
    expect((await failure(as(pg, ownerA.who, ...insertSql("session_events", [ev]))))?.code).toBe("42501");
  });

  it("nobody can delete rows (no DELETE grant on any table)", async () => {
    for (const who of [ownerA.who, ownerB.who, hostA.who]) {
      for (const table of ["hosts", "sessions", "session_events", "session_messages", "notification_prefs"]) {
        expect((await failure(as(pg, who, `delete from public.${table}`)))?.code).toBe("42501");
      }
    }
  });

  it("owners cannot revoke or rename another owner's host", async () => {
    expect(await as(pg, ownerB.who, "update public.hosts set revoked_at = now() where id = $1 returning id", [hostA.id])).toEqual([]);
    expect(await as(pg, ownerB.who, "update public.hosts set name = 'pwned' where id = $1 returning id", [hostA.id])).toEqual([]);
    const [h] = await as<{ name: string; revoked_at: string | null }>(pg, ownerA.who, "select name, revoked_at from public.hosts where id = $1", [hostA.id]);
    expect(h).toEqual({ name: "Test laptop", revoked_at: null });
  });

  it("owners cannot move a host to another owner", async () => {
    expect((await failure(as(pg, ownerA.who, "update public.hosts set owner_id = $1 where id = $2", [ownerB.id, hostA.id])))?.code).toBe("42501");
  });

  it("owners cannot read pairing secrets", async () => {
    expect((await failure(as(pg, ownerA.who, "select * from public.host_pairings")))?.code).toBe("42501");
  });

  it("notification preferences are per owner", async () => {
    await as(pg, ownerA.who, ...insertSql("notification_prefs", [{ owner_id: ownerA.id, on_completed: false }]));
    expect((await failure(as(pg, ownerA.who, ...insertSql("notification_prefs", [{ owner_id: ownerB.id }]))))?.code).toBe("42501");
    expect(await as(pg, ownerB.who, "select * from public.notification_prefs where owner_id = $1", [ownerA.id])).toEqual([]);
    expect(await as(pg, ownerB.who, "update public.notification_prefs set on_failed = false where owner_id = $1 returning owner_id", [ownerA.id])).toEqual([]);
    // A host is not an owner, even of its own owner's preferences.
    expect(await as(pg, hostA.who, "select * from public.notification_prefs")).toEqual([]);
    expect((await failure(as(pg, hostA.who, ...insertSql("notification_prefs", [{ owner_id: hostA.authUserId }]))))?.code).toBe("42501");
  });

  it("owners cannot read another owner's events or messages", async () => {
    await as(pg, hostA.who, ...insertSql("session_events", [{ host_id: hostA.id, session_id: sessionA, type: "status_changed", status: "running", dedupe_key: "iso-1" }]));
    await as(pg, hostA.who, ...insertSql("session_messages", [{ host_id: hostA.id, session_id: sessionA, external_uuid: "iso-m1", role: "user", text: "hello" }]));
    expect((await as(pg, ownerA.who, "select id from public.session_events where dedupe_key = 'iso-1'")).length).toBe(1);
    expect((await as(pg, ownerA.who, "select id from public.session_messages where external_uuid = 'iso-m1'")).length).toBe(1);
    expect(await as(pg, ownerB.who, "select id from public.session_events where session_id = $1", [sessionA])).toEqual([]);
    expect(await as(pg, ownerB.who, "select id from public.session_messages where session_id = $1", [sessionA])).toEqual([]);
    expect(await as(pg, hostB.who, "select id from public.session_messages where session_id = $1", [sessionA])).toEqual([]);
  });
});

describe("host isolation", () => {
  it("hosts see only their own host row and sessions", async () => {
    expect(ids(await as(pg, hostA.who, "select id from public.hosts"))).toEqual([hostA.id]);
    expect(ids(await as(pg, hostA.who, "select id from public.sessions"))).toEqual([sessionA]);
  });

  it("hosts cannot write under another host", async () => {
    expect((await failure(insertSession(hostA, { ...sessionRow(), host_id: hostB.id })))?.code).toBe("42501");
  });

  it("hosts cannot set owner_id (column not writable)", async () => {
    expect((await failure(insertSession(hostA, { ...sessionRow(), owner_id: ownerB.id })))?.code).toBe("42501");
  });

  it("owner_id is derived from the host, not the caller", async () => {
    const [r] = await as<{ owner_id: string }>(pg, ownerA.who, "select owner_id from public.sessions where id = $1", [sessionA]);
    expect(r?.owner_id).toBe(ownerA.id);
  });

  it("hosts cannot attach events or messages to another host's session", async () => {
    const ev = { host_id: hostA.id, session_id: sessionB, type: "status_changed", status: "failed", dedupe_key: "evil" };
    const e = await failure(as(pg, hostA.who, ...insertSql("session_events", [ev])));
    expect(e).toMatchObject({ code: "42501", message: "session does not belong to host" });
    const msg = { host_id: hostA.id, session_id: sessionB, external_uuid: "m1", role: "user", text: "x" };
    expect(await failure(as(pg, hostA.who, ...insertSql("session_messages", [msg])))).toMatchObject({ code: "42501" });
  });

  it("hosts cannot read or update other hosts' sessions", async () => {
    expect(await as(pg, hostA.who, "select id from public.sessions where id = $1", [sessionB])).toEqual([]);
    expect(await as(pg, hostA.who, "update public.sessions set status = 'failed', observed_at = now() where id = $1 returning id", [sessionB])).toEqual([]);
  });

  it("hosts cannot move a session to another host or change its identity", async () => {
    for (const [col, value] of [["host_id", hostB.id], ["provider", "claude-code"], ["external_id", "renamed"]] as const) {
      const e = await failure(as(pg, hostA.who, `update public.sessions set ${col} = $1 where id = $2`, [value, sessionA]));
      expect(e).toMatchObject({ code: "42501", message: "immutable session columns" });
    }
    expect((await failure(as(pg, hostA.who, "update public.sessions set owner_id = $1 where id = $2", [ownerB.id, sessionA])))?.code).toBe("42501");
  });

  it("hosts cannot start pairings or edit host rows", async () => {
    expect(await failure(as(pg, hostA.who, "select * from public.create_host_pairing('x')"))).toMatchObject({ code: "42501", message: "only owners can pair hosts" });
    expect(await as(pg, hostA.who, "update public.hosts set name = 'renamed' where id = $1 returning id", [hostA.id])).toEqual([]);
  });

  it("heartbeat updates only the caller's host", async () => {
    await as(pg, hostA.who, "select public.host_heartbeat('win32', 't', false, true)");
    const [h] = await as<{ last_seen_at: unknown; remote_control_allowed: boolean }>(
      pg, ownerA.who, "select last_seen_at, remote_control_allowed from public.hosts where id = $1", [hostA.id]);
    expect(h?.last_seen_at).not.toBeNull();
    expect(h?.remote_control_allowed).toBe(false);
    const [other] = await as<{ last_seen_at: unknown }>(pg, ownerB.who, "select last_seen_at from public.hosts where id = $1", [hostB.id]);
    expect(other?.last_seen_at).toBeNull();
    // Reaches the function and is refused there (not a missing signature).
    expect(await failure(as(pg, ownerA.who, "select public.host_heartbeat('x', 'x', true, true)"))).toMatchObject({ code: "42501", message: "not an active host" });
  });
});

describe("source health (schema v2)", () => {
  const beat = (ok: boolean | null) => as(pg, hostA.who, "select public.host_heartbeat('win32', 't', false, $1)", [ok]);
  const since = async () =>
    (await as<{ provider_error_since: Date | null }>(pg, ownerA.who, "select provider_error_since from public.hosts where id = $1", [hostA.id]))[0]
      ?.provider_error_since ?? null;

  it("is set and cleared only through the heartbeat, keeping the failure start", async () => {
    await beat(true);
    expect(await since()).toBeNull();
    await beat(false);
    const first = await since();
    expect(first).toBeInstanceOf(Date);
    await beat(false); // a later transaction, so now() differs
    expect(await since()).toEqual(first);
    await beat(true);
    expect(await since()).toBeNull();
  });

  it("rejects a missing health value and the removed v1 signature", async () => {
    expect((await failure(beat(null)))?.code).toBe("22004");
    expect((await failure(as(pg, hostA.who, "select public.host_heartbeat('x', 'x', false)")))?.code).toBe("42883");
  });

  it("nobody can write provider_error_since directly", async () => {
    expect((await failure(as(pg, ownerA.who, "update public.hosts set provider_error_since = now() where id = $1", [hostA.id])))?.code).toBe("42501");
    expect((await failure(as(pg, hostA.who, "update public.hosts set provider_error_since = null where id = $1", [hostA.id])))?.code).toBe("42501");
  });

  it("another owner cannot see a host's source health", async () => {
    expect(await as(pg, ownerB.who, "select provider_error_since from public.hosts where id = $1", [hostA.id])).toEqual([]);
  });
});

describe("event deduplication", () => {
  it("rejects a duplicate dedupe_key and ignores it on upsert", async () => {
    const ev = { host_id: hostA.id, session_id: sessionA, type: "status_changed", status: "waiting_for_input", dedupe_key: `k-${randomUUID()}` };
    await as(pg, hostA.who, ...insertSql("session_events", [ev]));
    expect((await failure(as(pg, hostA.who, ...insertSql("session_events", [ev]))))?.code).toBe("23505");
    expect(await as(pg, hostA.who, ...upsertIgnoreSql("session_events", [ev], "session_id, dedupe_key"))).toEqual([]);
    const [c] = await as<{ n: number }>(pg, ownerA.who, "select count(*)::int as n from public.session_events where dedupe_key = $1", [ev.dedupe_key]);
    expect(c?.n).toBe(1);
  });
});

describe("stale-write guard (schema v3)", () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const upsert = (row: Record<string, unknown>) => upsertAs(hostA.who, [{ ...row, host_id: hostA.id }]);
  const stored = async (ext: string) =>
    (await as<{ status: string; observed_at: Date; updated_at: Date }>(
      pg, ownerA.who, "select status, observed_at, updated_at from public.sessions where external_id = $1", [ext]))[0];

  it("skips an older write without an error and without returning the row", async () => {
    const ext = `stale-${randomUUID()}`;
    expect(await upsert({ ...sessionRow(ext, at(10)), status: "approval_required" })).toHaveLength(1);
    const before = await stored(ext);

    expect(await upsert({ ...sessionRow(ext, at(20)), status: "running" })).toEqual([]); // no error, absent from RETURNING
    expect(await as(pg, hostA.who, "update public.sessions set status = 'failed', observed_at = $1 where external_id = $2 returning id", [at(30), ext])).toEqual([]);
    expect(await stored(ext)).toEqual(before); // status, observation time and updated_at untouched
    expect(before?.status).toBe("approval_required");
  });

  it("skips only the stale rows of a connector batch", async () => {
    const stale = `batch-stale-${randomUUID()}`;
    const fresh = `batch-fresh-${randomUUID()}`;
    await upsert(sessionRow(stale, at(5)));
    await upsert(sessionRow(fresh, at(5)));
    const res = await upsertAs(hostA.who, [
      { ...sessionRow(stale, at(15)), status: "failed", host_id: hostA.id },
      { ...sessionRow(fresh, at(1)), status: "completed", host_id: hostA.id },
    ]);
    expect(res.map((r) => r.external_id)).toEqual([fresh]);
    expect((await stored(stale))?.status).toBe("running");
    expect((await stored(fresh))?.status).toBe("completed");
  });

  it("applies an equal observation idempotently", async () => {
    const ext = `equal-${randomUUID()}`;
    const row = { ...sessionRow(ext, at(10)), status: "waiting_for_input" };
    const [first] = await upsert(row);
    const [again] = await upsert(row);
    expect(again?.id).toBe(first?.id);
    expect((await stored(ext))?.status).toBe("waiting_for_input");
    const [c] = await as<{ n: number }>(pg, ownerA.who, "select count(*)::int as n from public.sessions where external_id = $1", [ext]);
    expect(c?.n).toBe(1);
  });

  it("treats an update that omits observed_at as equal (applied, time kept)", async () => {
    const ext = `omit-${randomUUID()}`;
    await upsert(sessionRow(ext, at(10)));
    const before = await stored(ext);
    expect(await as(pg, hostA.who, "update public.sessions set status = 'completed' where external_id = $1 returning id", [ext])).toHaveLength(1);
    const after = await stored(ext);
    expect(after?.status).toBe("completed");
    expect(after?.observed_at).toEqual(before?.observed_at);
  });

  it("lets a newer observation win and bumps updated_at", async () => {
    const ext = `newer-${randomUUID()}`;
    await upsert(sessionRow(ext, at(10)));
    const before = await stored(ext);
    const next = await upsert({ ...sessionRow(ext, at(5)), status: "completed" });
    expect(next).toHaveLength(1);
    const after = await stored(ext);
    expect(after?.status).toBe("completed");
    expect(after?.updated_at.getTime() ?? 0).toBeGreaterThanOrEqual(before?.updated_at.getTime() ?? Infinity);
  });

  it("clamps far-future observation times to five minutes ahead", async () => {
    const ext = `future-${randomUUID()}`;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const row = { ...sessionRow(ext, tomorrow), host_id: hostA.id };
    const [r] = await as<{ ahead: number }>(pg, hostA.who, ...upsertSql("sessions", [row], KEY, "extract(epoch from observed_at - now())::float8 as ahead"));
    expect(r?.ahead).toBe(300); // exactly now() + 5 minutes in the writing transaction
    // A second far-future write clamps to a later bound, so the session still updates.
    expect(await upsert({ ...sessionRow(ext, tomorrow), status: "failed" })).toHaveLength(1);
    expect((await stored(ext))?.status).toBe("failed");
  });

  it("requires an observation time on every write", async () => {
    const noObservation = Object.fromEntries(Object.entries(sessionRow()).filter(([k]) => k !== "observed_at"));
    expect(await failure(insertSession(hostA, noObservation))).toMatchObject({ code: "23502", message: "observed_at is required" });
    expect(await failure(insertSession(hostA, sessionRow(randomUUID(), null)))).toMatchObject({ code: "23502" });
    expect(await failure(as(pg, hostA.who, "update public.sessions set observed_at = null where id = $1", [sessionA])))
      .toMatchObject({ code: "23502", message: "observed_at is required" }); // not turned into now() + 5 min
    expect(await failure(upsert(sessionRow(`null-${randomUUID()}`, null)))).toMatchObject({ code: "23502" });
  });

  it("has no default for observed_at after the backfill", async () => {
    const { rows } = await pg.query<{ d: unknown }>(
      "select column_default as d from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name = 'observed_at'");
    expect(rows).toEqual([{ d: null }]);
  });

  it("allows PostgREST's upsert to set the conflict key columns (v3 grants)", async () => {
    const [g] = await pg.query<{ host_id: boolean; provider: boolean; external_id: boolean; owner_id: boolean }>(
      `select has_column_privilege('authenticated', 'public.sessions', 'host_id', 'UPDATE') as host_id,
              has_column_privilege('authenticated', 'public.sessions', 'provider', 'UPDATE') as provider,
              has_column_privilege('authenticated', 'public.sessions', 'external_id', 'UPDATE') as external_id,
              has_column_privilege('authenticated', 'public.sessions', 'owner_id', 'UPDATE') as owner_id`).then((x) => x.rows);
    expect(g).toEqual({ host_id: true, provider: true, external_id: true, owner_id: false });
    // The conflict path SETs host_id/provider/external_id to their current values: allowed, not "immutable".
    const ext = `grants-${randomUUID()}`;
    await upsert(sessionRow(ext, at(10)));
    expect(await upsert({ ...sessionRow(ext, at(9)), status: "completed" })).toHaveLength(1);
  });

  it("still refuses to move a session even when the write is stale", async () => {
    const e = await failure(as(pg, hostA.who, "update public.sessions set host_id = $1, observed_at = $2 where id = $3", [hostB.id, at(60 * 24 * 365), sessionA]));
    expect(e).toMatchObject({ code: "42501", message: "immutable session columns" });
  });

  it("doesn't let another host freeze this host's row with a future observation", async () => {
    const ext = `cross-${randomUUID()}`;
    await upsert(sessionRow(ext, at(10)));
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    // Host B targets A's conflict key; RLS must refuse rather than update A's row.
    const forged = await failure(upsertAs(hostB.who, [{ ...sessionRow(ext, future), host_id: hostA.id }]));
    expect(forged?.code).toBe("42501");
    expect(forged?.message).toMatch(/row-level security/);
    expect(await upsert({ ...sessionRow(ext, at(5)), status: "completed" })).toHaveLength(1);
  });

  it("still gives owners no write access, whatever the observation time", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await as(pg, ownerA.who, "update public.sessions set status = 'failed', observed_at = $1 where id = $2 returning id", [future, sessionA])).toEqual([]);
    expect((await failure(upsertAs(ownerA.who, [{ ...sessionRow(randomUUID(), future), host_id: hostA.id }])))?.code).toBe("42501");
  });
});

describe("forged identity", () => {
  it("user_metadata claiming to be a host grants nothing", async () => {
    const id = await createAuthUser(pg);
    const forger: Principal = { role: "authenticated", claims: { sub: id, role: "authenticated", app_metadata: {}, user_metadata: { mc_role: "host", host_id: hostA.id } } };
    expect(await as(pg, forger, "select id from public.sessions")).toEqual([]);
    expect(await as(pg, forger, "select id from public.hosts")).toEqual([]);
    expect((await failure(as(pg, forger, ...insertSql("sessions", [{ ...sessionRow(), host_id: hostA.id }]))))?.code).toBe("42501");
  });

  it("a host claim is honoured only for the host's own auth user", async () => {
    // Defence in depth: even a token with the right app_metadata but another sub is refused.
    const other = await createAuthUser(pg);
    const wrongSub = hostPrincipal(other, hostA.id);
    expect(await as(pg, wrongSub, "select id from public.sessions")).toEqual([]);
    expect((await failure(insertSession({ ...hostA, who: wrongSub })))?.code).toBe("42501");
    // A host token is never treated as an owner, so it can't read as one either.
    expect(await as(pg, wrongSub, "select id from public.hosts")).toEqual([]);
  });
});

describe("pairing (RPC level; pair-host's HTTP layer not exercised)", () => {
  it("codes are single-use and only the service role can redeem", async () => {
    const owner = await createOwner(pg);
    const { code } = await startPairing(pg, owner);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect((await failure(as(pg, owner.who, "select public.peek_host_pairing($1)", [code])))?.code).toBe("42501");
    expect((await failure(as(pg, owner.who, "select public.claim_host_pairing($1, $2, '', '')", [code, owner.id])))?.code).toBe("42501");
    expect(await redeem(pg, code)).not.toBeNull();
    expect(await redeem(pg, code)).toBeNull();
  });

  it("stores only the code's hash", async () => {
    const owner = await createOwner(pg);
    const { code, host_id } = await startPairing(pg, owner);
    const [p] = (await pg.query<{ code_hash: string }>("select code_hash from public.host_pairings where host_id = $1", [host_id])).rows;
    expect(p?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p?.code_hash).not.toContain(code);
  });

  it("validates host names and limits pending pairings", async () => {
    const owner = await createOwner(pg);
    expect((await failure(startPairing(pg, owner, "   ")))?.code).toBe("22023");
    for (let i = 0; i < 5; i++) await startPairing(pg, owner, `pending ${i}`);
    expect((await failure(startPairing(pg, owner, "sixth")))?.code).toBe("54000");
  });

  it("expired codes cannot be redeemed", async () => {
    const owner = await createOwner(pg);
    const { code, host_id } = await startPairing(pg, owner);
    await pg.query("update public.host_pairings set expires_at = now() - interval '1 second' where host_id = $1", [host_id]);
    expect(await redeem(pg, code)).toBeNull();
  });

  it("revoked hosts cannot pair", async () => {
    const owner = await createOwner(pg);
    const { code, host_id } = await startPairing(pg, owner);
    expect(await as(pg, owner.who, "update public.hosts set revoked_at = now() where id = $1 returning id", [host_id])).toHaveLength(1);
    expect(await redeem(pg, code)).toBeNull();
  });
});

describe("revocation", () => {
  it("takes effect immediately for writes and reads, and cannot be undone", async () => {
    const owner = await createOwner(pg);
    const host = await pairHost(pg, owner);
    await insertSession(host);

    expect(await as(pg, owner.who, "update public.hosts set revoked_at = now() where id = $1 returning id", [host.id])).toHaveLength(1);

    // Same claims (an unexpired JWT), but the host row is revoked.
    expect((await failure(insertSession(host)))?.code).toBe("42501");
    expect(await as(pg, host.who, "select id from public.sessions")).toEqual([]);
    expect(await as(pg, host.who, "update public.sessions set status = 'failed' returning id")).toEqual([]);
    expect((await failure(as(pg, host.who, "select public.host_heartbeat('x', 'x', null, true)")))?.code).toBe("42501");

    expect(await failure(as(pg, owner.who, "update public.hosts set revoked_at = null where id = $1", [host.id])))
      .toMatchObject({ code: "42501", message: "host revocation cannot be undone" });
  });
});

// Asserted here rather than left implicit: the security-definer helpers must
// not be callable by anon, and the trigger functions by nobody.
describe("function privileges", () => {
  it("match the migrations' revoke/grant lists", async () => {
    const can = async (role: string, fn: string) =>
      (await pg.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn])).rows[0]?.ok;
    for (const fn of ["public.create_host_pairing(text)", "public.host_heartbeat(text, text, boolean, boolean)", "public.owner_uid()", "public.active_host_id()"]) {
      expect(await can("anon", fn)).toBe(false);
      expect(await can("authenticated", fn)).toBe(true);
    }
    for (const fn of ["public.peek_host_pairing(text)", "public.claim_host_pairing(text, uuid, text, text)"]) {
      expect(await can("anon", fn)).toBe(false);
      expect(await can("authenticated", fn)).toBe(false);
      expect(await can("service_role", fn)).toBe(true);
    }
    for (const fn of ["public.set_owner_from_host()", "public.sessions_guard_update()", "public.hosts_guard_update()", "public.sessions_bound_observed_at()"]) {
      expect(await can("anon", fn)).toBe(false);
      expect(await can("authenticated", fn)).toBe(false);
    }
  });
});
