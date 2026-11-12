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
  applySeed,
  as,
  createAuthUser,
  createOwner,
  failure,
  freshDatabase,
  hostPrincipal,
  insertSql,
  migrationFiles,
  pairHost,
  realtimeAccess,
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
  // As on the local stack (`supabase db reset`); the transcript tests switch it off.
  await applySeed(pg);
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
  it("apply in order on top of the shim and end at schema v4", async () => {
    expect(migrationFiles()).toEqual([
      "20261029000001_schema_v1.sql",
      "20261102000001_source_health.sql",
      "20261103000001_stale_write_guard.sql",
      "20261104000001_fix_set_owner_from_host.sql",
      "20261105000001_security_hardening.sql",
      "20261112000001_provider_error_kind.sql",
    ]);
    const [meta] = await as<{ schema_version: number }>(pg, anon, "select schema_version from public.app_meta");
    expect(meta?.schema_version).toBe(4);
  });

  it("publish only sessions and events to Realtime: no host heartbeats, never transcript messages", async () => {
    const rows = (await pg.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1")).rows;
    expect(rows.map((r) => r.tablename)).toEqual(["session_events", "sessions"]);
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

describe("source failure categories (schema v4)", () => {
  const beat = (ok: boolean | null, kind: string | null) =>
    as(pg, hostA.who, "select public.host_heartbeat('win32', 't', false, $1, $2)", [ok, kind]);
  const health = async () =>
    (await as<{ provider_error_since: Date | null; provider_error_kind: string | null }>(
      pg, ownerA.who, "select provider_error_since, provider_error_kind from public.hosts where id = $1", [hostA.id]))[0];

  it("stores the category with the failure, follows a change of kind, and recovery clears both", async () => {
    await beat(true, null);
    expect(await health()).toEqual({ provider_error_since: null, provider_error_kind: null });
    await beat(false, "cli_missing");
    const first = await health();
    expect(first?.provider_error_kind).toBe("cli_missing");
    expect(first?.provider_error_since).toBeInstanceOf(Date);
    await beat(false, "auth_required"); // same failure, new cause: the start is kept
    expect(await health()).toEqual({ provider_error_since: first?.provider_error_since, provider_error_kind: "auth_required" });
    await beat(true, null);
    expect(await health()).toEqual({ provider_error_since: null, provider_error_kind: null });
  });

  it("accepts every known category", async () => {
    for (const kind of ["cli_missing", "auth_required", "timeout", "invalid_output", "incompatible_version", "interrupted", "failed", "writes_not_applied"]) {
      await beat(false, kind);
      expect((await health())?.provider_error_kind).toBe(kind);
    }
    await beat(true, null);
  });

  it("rejects an unknown category, free text, and a category on a healthy source", async () => {
    for (const kind of ["CLI_MISSING", "unknown", "", "claude: command not found at /home/dev/bin"]) {
      expect(await failure(beat(false, kind))).toMatchObject({ code: "22023", message: "unknown provider error kind" });
    }
    expect(await failure(beat(true, "timeout"))).toMatchObject({ code: "22023", message: "a healthy source has no error kind" });
    expect((await failure(beat(null, "timeout")))?.code).toBe("22004");
    expect(await health()).toEqual({ provider_error_since: null, provider_error_kind: null }); // nothing was written
  });

  it("keeps a v3 connector's four-argument call working: its failure has no category", async () => {
    await as(pg, hostA.who, "select public.host_heartbeat('win32', 't', false, false)");
    const h = await health();
    expect(h?.provider_error_since).toBeInstanceOf(Date);
    expect(h?.provider_error_kind).toBeNull();
    await as(pg, hostA.who, "select public.host_heartbeat('win32', 't', false, true)");
    expect(await health()).toEqual({ provider_error_since: null, provider_error_kind: null });
  });

  it("only an active host can report a category", async () => {
    expect(await failure(as(pg, ownerA.who, "select public.host_heartbeat('x', 'x', false, false, 'timeout')"))).toMatchObject({ code: "42501", message: "not an active host" });
    expect((await failure(as(pg, anon, "select public.host_heartbeat('x', 'x', false, false, 'timeout')")))?.code).toBe("42501");
    expect((await health())?.provider_error_kind).toBeNull();
  });

  it("nobody can write provider_error_kind directly, and the table enforces the list", async () => {
    expect((await failure(as(pg, ownerA.who, "update public.hosts set provider_error_kind = 'timeout' where id = $1", [hostA.id])))?.code).toBe("42501");
    expect((await failure(as(pg, hostA.who, "update public.hosts set provider_error_kind = 'timeout' where id = $1", [hostA.id])))?.code).toBe("42501");
    // Even the database owner can't store free text, or a category without a failure.
    expect((await failure(pg.query("update public.hosts set provider_error_since = now(), provider_error_kind = 'free text' where id = $1", [hostA.id])))?.code).toBe("23514");
    expect((await failure(pg.query("update public.hosts set provider_error_since = null, provider_error_kind = 'timeout' where id = $1", [hostA.id])))?.code).toBe("23514");
  });

  it("another owner cannot see a host's failure category", async () => {
    expect(await as(pg, ownerB.who, "select provider_error_kind from public.hosts where id = $1", [hostA.id])).toEqual([]);
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

describe("owner identity fails closed (S4)", () => {
  /** A token as GoTrue would issue it for `sub`, with these server-set app_metadata extras. */
  const withAppMetadata = (sub: string, extra: Record<string, unknown>): Principal => ({
    role: "authenticated",
    claims: { sub, role: "authenticated", aal: "aal1", app_metadata: { provider: "email", providers: ["email"], ...extra }, user_metadata: {} },
  });
  const ownerUid = async (who: Principal) => (await as<{ uid: string | null }>(pg, who, "select public.owner_uid() as uid"))[0]?.uid;

  for (const [label, hostId] of [
    ["not a uuid", "not-a-uuid"],
    ["36 hyphens (passed the v1 pattern, then failed the cast)", "-".repeat(36)],
    ["empty", ""],
    ["missing", undefined],
    ["a JSON number", 42],
  ] as const) {
    it(`a host claim with a malformed host_id (${label}) is neither a host nor an owner`, async () => {
      // The sub of a real owner: before the fix this token read ownerA's data.
      const who = withAppMetadata(ownerA.id, { mc_role: "host", ...(hostId === undefined ? {} : { host_id: hostId }) });
      expect(await ownerUid(who)).toBeNull();
      expect(await as(pg, who, "select id from public.hosts")).toEqual([]);
      expect(await as(pg, who, "select id from public.sessions")).toEqual([]);
      expect(await as(pg, who, "select * from public.notification_prefs")).toEqual([]);
      expect(await failure(as(pg, who, "select * from public.create_host_pairing('x')"))).toMatchObject({ code: "42501", message: "only owners can pair hosts" });
      expect(await as(pg, who, "update public.hosts set name = 'pwned' where id = $1 returning id", [hostA.id])).toEqual([]);
    });
  }

  it("any mc_role in app_metadata, whatever its value, removes owner rights", async () => {
    for (const role of ["admin", "owner", "", null]) {
      expect(await ownerUid(withAppMetadata(ownerA.id, { mc_role: role }))).toBeNull();
    }
    // Unchanged: a normal owner token, and user_metadata (user-writable) is ignored.
    expect(await ownerUid(ownerA.who)).toBe(ownerA.id);
    const userMeta: Principal = { role: "authenticated", claims: { sub: ownerA.id, role: "authenticated", app_metadata: {}, user_metadata: { mc_role: "host" } } };
    expect(await ownerUid(userMeta)).toBe(ownerA.id);
  });

  it("a well-formed host claim still works, in either letter case", async () => {
    const upper = hostPrincipal(hostA.authUserId, hostA.id.toUpperCase());
    const visible = ids(await as(pg, upper, "select id from public.sessions order by id"));
    expect(visible).toContain(sessionA);
    expect(visible).toEqual(ids(await as(pg, hostA.who, "select id from public.sessions order by id")));
    expect(await ownerUid(upper)).toBeNull();
  });
});

describe("read-only capabilities (S3, D-003)", () => {
  it("refuses any control capability on insert and update", async () => {
    for (const cap of ["send_message", "resume", "approve_requests"]) {
      const e = await failure(insertSession(hostA, { ...sessionRow(), capabilities: ["discover", cap] }));
      expect(e).toMatchObject({ code: "23514" });
      expect(await failure(as(pg, hostA.who, "update public.sessions set capabilities = $1 where id = $2", [["discover", cap], sessionA])))
        .toMatchObject({ code: "23514" });
    }
    expect(await failure(insertSession(hostA, { ...sessionRow(), capabilities: ["teleport"] }))).toMatchObject({ code: "23514" });
  });

  it("accepts every read-only capability", async () => {
    const id = await insertSession(hostA, { ...sessionRow(), capabilities: ["discover", "get_details", "read_messages", "subscribe_events"] });
    expect(id).toBeTruthy();
  });
});

describe("transcript storage gate (S2, D-004)", () => {
  const msg = () => ({ host_id: hostA.id, session_id: sessionA, external_uuid: `gate-${randomUUID()}`, role: "assistant", text: "excerpt" });
  const setEnabled = (on: boolean) => pg.query("update public.app_meta set transcripts_enabled = $1", [on]);
  const stored = async (uuid: string) => (await as(pg, ownerA.who, "select id from public.session_messages where external_uuid = $1", [uuid])).length;

  it("defaults to off: migrations alone never enable transcript storage", async () => {
    const { rows } = await pg.query<{ d: string; nullable: string }>(
      "select column_default as d, is_nullable as nullable from information_schema.columns where table_schema = 'public' and table_name = 'app_meta' and column_name = 'transcripts_enabled'");
    expect(rows).toEqual([{ d: "false", nullable: "NO" }]);
    const fresh = await freshDatabase();
    try {
      const [m] = (await fresh.query<{ on: boolean }>("select transcripts_enabled as on from public.app_meta")).rows;
      expect(m?.on).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  it("is switched on by the local seed", async () => {
    const [m] = await as<{ transcripts_enabled: boolean }>(pg, anon, "select transcripts_enabled from public.app_meta");
    expect(m?.transcripts_enabled).toBe(true);
  });

  it("refuses a host's transcript insert while disabled, and allows it while enabled", async () => {
    await setEnabled(false);
    try {
      const off = msg();
      const e = await failure(as(pg, hostA.who, ...insertSql("session_messages", [off])));
      expect(e?.code).toBe("42501");
      expect(e?.message).toMatch(/row-level security/);
      expect(await stored(off.external_uuid)).toBe(0);
    } finally {
      await setEnabled(true);
    }
    const on = msg();
    expect(await as(pg, hostA.who, ...insertSql("session_messages", [on], "id"))).toHaveLength(1);
    expect(await stored(on.external_uuid)).toBe(1);
  });

  it("still refuses another host's session while enabled", async () => {
    const forged = { ...msg(), session_id: sessionB };
    expect(await failure(as(pg, hostA.who, ...insertSql("session_messages", [forged])))).toMatchObject({ code: "42501" });
  });

  it("can't be toggled by an owner, a host or anon through the API", async () => {
    for (const who of [ownerA.who, hostA.who, anon]) {
      for (const on of [true, false]) {
        expect((await failure(as(pg, who, "update public.app_meta set transcripts_enabled = $1", [on])))?.code).toBe("42501");
      }
      expect((await failure(as(pg, who, "insert into public.app_meta (id, schema_version, transcripts_enabled) values (true, 3, true)")))?.code).toBe("42501");
    }
    const grants = (await pg.query<{ u: boolean; i: boolean }>(
      "select has_column_privilege('authenticated', 'public.app_meta', 'transcripts_enabled', 'UPDATE') as u, has_table_privilege('authenticated', 'public.app_meta', 'INSERT') as i")).rows;
    expect(grants).toEqual([{ u: false, i: false }]);
  });

  it("keeps transcript messages out of Realtime", async () => {
    const { rows } = await pg.query("select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'session_messages'");
    expect(rows).toEqual([]);
  });
});

// Realtime's own authorization is emulated (harness `realtimeAccess`); the
// Realtime service, its join flow and its caching are not exercised here.
describe("Realtime private channel (M5)", () => {
  const topic = () => `tavro-changes:${randomUUID()}`;

  it("lets a signed-in owner receive on a tavro-changes topic and send nothing", async () => {
    expect(await realtimeAccess(pg, ownerA.who, topic())).toEqual({ broadcast: true, presence: true, send: false });
  });

  it("refuses hosts, malformed host claims and anon", async () => {
    const malformed: Principal = { role: "authenticated", claims: { sub: ownerA.id, role: "authenticated", app_metadata: { mc_role: "host", host_id: "x" } } };
    for (const who of [hostA.who, malformed, anon]) {
      expect(await realtimeAccess(pg, who, topic())).toEqual({ broadcast: false, presence: false, send: false });
    }
  });

  it("refuses other topics, even for owners", async () => {
    for (const t of ["realtime:public", "tavro-changes", "other:tavro-changes:x", "mc-changes-abc"]) {
      expect(await realtimeAccess(pg, ownerA.who, t)).toEqual({ broadcast: false, presence: false, send: false });
    }
  });
});

// Asserted here rather than left implicit: the security-definer helpers must
// not be callable by anon, and the trigger functions by nobody.
describe("function privileges", () => {
  it("match the migrations' revoke/grant lists", async () => {
    const can = async (role: string, fn: string) =>
      (await pg.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn])).rows[0]?.ok;
    // owner_uid and jwt_host_id were replaced in 20261105000001; CREATE OR REPLACE must have kept these.
    for (const fn of ["public.create_host_pairing(text)", "public.host_heartbeat(text, text, boolean, boolean, text)", "public.owner_uid()", "public.active_host_id()", "public.jwt_host_id()"]) {
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

  it("keep the replaced identity helpers' owner and invoker security", async () => {
    const { rows } = await pg.query<{ proname: string; owner: string; definer: boolean; config: string[] | null }>(
      `select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('owner_uid', 'jwt_host_id', 'active_host_id') order by 1`);
    expect(rows).toEqual([
      { proname: "active_host_id", owner: "postgres", definer: true, config: ["search_path=\"\""] },
      { proname: "jwt_host_id", owner: "postgres", definer: false, config: ["search_path=\"\""] },
      { proname: "owner_uid", owner: "postgres", definer: false, config: ["search_path=\"\""] },
    ]);
  });
});
