// SQL-level (PGlite) upgrade-path test — NOT a substitute for `npm run test:db`.
// Applies the migrations one at a time with data already present, as an
// existing project would, and checks what each step does to that data.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration, as, createOwner, freshDatabase, insertSql, migrationFiles, pairHost, sessionRow, upsertSql, type Host, type Owner } from "./harness.js";

const [v1, v2, v3, ownerFix, hardening] = migrationFiles();
let pg: PGlite;
let owner: Owner;
let host: Host;
const ext = `pre-v3-${randomUUID()}`;

const version = async () => (await pg.query<{ v: number }>("select schema_version as v from public.app_meta")).rows[0]?.v;

beforeAll(async () => {
  if (!v1 || !v2 || !v3 || !ownerFix || !hardening) throw new Error("expected five migrations");
  // On v1 alone no host could insert a session (fixed by 20261104000001), so a
  // v1 project with data has that fix: its body is v1-compatible.
  pg = await freshDatabase([v1, ownerFix]);
  owner = await createOwner(pg);
  host = await pairHost(pg, owner);
  // A v1 connector write: no observed_at column yet.
  const v1Row = Object.fromEntries(Object.entries(sessionRow(ext)).filter(([k]) => k !== "observed_at"));
  await as(pg, host.who, ...insertSql("sessions", [{ ...v1Row, host_id: host.id, status: "waiting_for_input" }], "id"));
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe("upgrading a v1 database with data", () => {
  it("v1 → v2 keeps existing hosts healthy and the v1 heartbeat is gone", async () => {
    expect(await version()).toBe(1);
    await applyMigration(pg, v2 ?? "");
    expect(await version()).toBe(2);
    const [h] = await as<{ provider_error_since: unknown }>(pg, owner.who, "select provider_error_since from public.hosts where id = $1", [host.id]);
    expect(h?.provider_error_since).toBeNull();
    await expect(as(pg, host.who, "select public.host_heartbeat('x', 'x', false)")).rejects.toMatchObject({ code: "42883" });
  });

  it("v2 → v3 backfills -infinity, so the first v3 write wins whatever its time", async () => {
    await applyMigration(pg, v3 ?? "");
    expect(await version()).toBe(3);
    const [before] = (await pg.query<{ inf: boolean }>("select observed_at = '-infinity' as inf from public.sessions where external_id = $1", [ext])).rows;
    expect(before?.inf).toBe(true);
    const old = new Date(Date.UTC(2000, 0, 1)).toISOString();
    const rows = await as(pg, host.who, ...upsertSql("sessions", [{ ...sessionRow(ext, old), host_id: host.id, status: "completed" }], "host_id, provider, external_id", "status"));
    expect(rows).toEqual([{ status: "completed" }]);
  });

  it("v3 → hardening strips stored control capabilities, keeps stored transcripts and turns new ones off", async () => {
    // Data a v3 project could hold: control capabilities (allowed by v1's
    // check) and a transcript excerpt (allowed on every project before).
    const wide = `wide-${randomUUID()}`;
    const [s] = await as<{ id: string }>(pg, host.who, ...upsertSql("sessions",
      [{ ...sessionRow(wide), host_id: host.id, capabilities: ["discover", "send_message", "get_details", "approve_requests", "resume"] }],
      "host_id, provider, external_id", "id"));
    await as(pg, host.who, ...insertSql("session_messages", [{ host_id: host.id, session_id: s?.id, external_uuid: "pre", role: "user", text: "old" }]));

    await applyMigration(pg, hardening ?? "");
    expect(await version()).toBe(3);

    const [after] = await as<{ capabilities: string[] }>(pg, owner.who, "select capabilities from public.sessions where external_id = $1", [wide]);
    expect(after?.capabilities).toEqual(["discover", "get_details"]); // order kept
    expect(await as(pg, owner.who, "select text from public.session_messages where external_uuid = 'pre'")).toEqual([{ text: "old" }]);
    await expect(as(pg, host.who, ...insertSql("session_messages", [{ host_id: host.id, session_id: s?.id, external_uuid: "post", role: "user", text: "new" }])))
      .rejects.toMatchObject({ code: "42501" });
    const pub = (await pg.query<{ t: string }>("select tablename as t from pg_publication_tables where pubname = 'supabase_realtime' order by 1")).rows;
    expect(pub.map((r) => r.t)).toEqual(["session_events", "sessions"]);
  });
});

describe("hardening on a project whose hosts table already left the publication", () => {
  it("applies cleanly when hosts was removed by hand first", async () => {
    const db = await freshDatabase([v1 ?? "", v2 ?? "", v3 ?? "", ownerFix ?? ""]);
    try {
      await db.exec("alter publication supabase_realtime drop table public.hosts");
      // The unguarded statement would fail here: that's what the DO block avoids.
      await expect(db.exec("alter publication supabase_realtime drop table public.hosts")).rejects.toThrow();
      await applyMigration(db, hardening ?? "");
      const pub = (await db.query<{ t: string }>("select tablename as t from pg_publication_tables where pubname = 'supabase_realtime' order by 1")).rows;
      expect(pub.map((r) => r.t)).toEqual(["session_events", "sessions"]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
