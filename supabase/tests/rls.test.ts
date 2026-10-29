import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  createOwner,
  localEnv,
  pairHost,
  redeem,
  sessionRow,
  signedIn,
  startPairing,
  type Host,
  type LocalEnv,
  type Owner,
} from "./helpers.js";

let env: LocalEnv;
let ownerA: Owner;
let ownerB: Owner;
let hostA: Host;
let hostB: Host;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  env = localEnv();
  ownerA = await createOwner(env);
  ownerB = await createOwner(env);
  hostA = await pairHost(env, ownerA);
  hostB = await pairHost(env, ownerB);

  const a = await hostA.client.from("sessions").insert({ ...sessionRow(), host_id: hostA.id }).select("id").single();
  if (a.error) throw a.error;
  sessionA = a.data.id;
  const b = await hostB.client.from("sessions").insert({ ...sessionRow(), host_id: hostB.id }).select("id").single();
  if (b.error) throw b.error;
  sessionB = b.data.id;
});

describe("anonymous (publishable key only)", () => {
  it("can read the schema version and nothing else", async () => {
    const anon = anonClient(env);
    const meta = await anon.from("app_meta").select("schema_version").single();
    expect(meta.data?.schema_version).toBe(1);
    for (const table of ["hosts", "sessions", "session_events", "session_messages", "notification_prefs", "host_pairings"]) {
      const r = await anon.from(table).select("*");
      // Either a permission error or zero rows; never data.
      expect(r.data ?? []).toHaveLength(0);
    }
  });

  it("cannot call privileged RPCs", async () => {
    const anon = anonClient(env);
    expect((await anon.rpc("create_host_pairing", { p_name: "x" })).error).not.toBeNull();
    expect((await anon.rpc("peek_host_pairing", { p_code: "AAAA-AAAA-AAAA" })).error).not.toBeNull();
    expect(
      (await anon.rpc("claim_host_pairing", { p_code: "AAAA-AAAA-AAAA", p_auth_user_id: randomUUID(), p_platform: "", p_connector_version: "" })).error,
    ).not.toBeNull();
  });
});

describe("owner isolation", () => {
  it("owners see only their own hosts and sessions", async () => {
    const hostsA = await ownerA.client.from("hosts").select("id");
    expect(hostsA.data?.map((h) => h.id)).toEqual([hostA.id]);
    const sessA = await ownerA.client.from("sessions").select("id");
    expect(sessA.data?.map((s) => s.id)).toEqual([sessionA]);
    const crossRead = await ownerB.client.from("sessions").select("id").eq("id", sessionA);
    expect(crossRead.data).toEqual([]);
  });

  it("owners cannot write sessions or events", async () => {
    const ins = await ownerA.client.from("sessions").insert({ ...sessionRow(), host_id: hostA.id });
    expect(ins.error).not.toBeNull();
    const upd = await ownerA.client.from("sessions").update({ status: "failed" }).eq("id", sessionA).select();
    expect(upd.data ?? []).toHaveLength(0);
    const ev = await ownerA.client
      .from("session_events")
      .insert({ host_id: hostA.id, session_id: sessionA, type: "status_changed", status: "failed", dedupe_key: "x" });
    expect(ev.error).not.toBeNull();
  });

  it("owners cannot revoke or rename another owner's host", async () => {
    const r = await ownerB.client.from("hosts").update({ revoked_at: new Date().toISOString() }).eq("id", hostA.id).select();
    expect(r.data ?? []).toHaveLength(0);
    const n = await ownerB.client.from("hosts").update({ name: "pwned" }).eq("id", hostA.id).select();
    expect(n.data ?? []).toHaveLength(0);
  });

  it("owners cannot read pairing secrets", async () => {
    const r = await ownerA.client.from("host_pairings").select("*");
    expect(r.data ?? []).toHaveLength(0);
  });

  it("notification preferences are per owner", async () => {
    const mine = await ownerA.client.from("notification_prefs").insert({ owner_id: ownerA.id, on_completed: false });
    expect(mine.error).toBeNull();
    const forged = await ownerA.client.from("notification_prefs").insert({ owner_id: ownerB.id });
    expect(forged.error).not.toBeNull();
    const peek = await ownerB.client.from("notification_prefs").select("*").eq("owner_id", ownerA.id);
    expect(peek.data).toEqual([]);
  });
});

describe("host isolation", () => {
  it("hosts cannot write under another host", async () => {
    const r = await hostA.client.from("sessions").insert({ ...sessionRow(), host_id: hostB.id });
    expect(r.error).not.toBeNull();
  });

  it("hosts cannot set owner_id (column not writable)", async () => {
    const r = await hostA.client.from("sessions").insert({ ...sessionRow(), host_id: hostA.id, owner_id: ownerB.id });
    expect(r.error).not.toBeNull();
  });

  it("owner_id is derived from the host, not the caller", async () => {
    const r = await ownerA.client.from("sessions").select("owner_id").eq("id", sessionA).single();
    expect(r.data?.owner_id).toBe(ownerA.id);
  });

  it("hosts cannot attach events to another host's session", async () => {
    const r = await hostA.client
      .from("session_events")
      .insert({ host_id: hostA.id, session_id: sessionB, type: "status_changed", status: "failed", dedupe_key: "evil" });
    expect(r.error).not.toBeNull();
    const m = await hostA.client
      .from("session_messages")
      .insert({ host_id: hostA.id, session_id: sessionB, external_uuid: "m1", role: "user", text: "x" });
    expect(m.error).not.toBeNull();
  });

  it("hosts cannot read or update other hosts' sessions", async () => {
    expect((await hostA.client.from("sessions").select("id").eq("id", sessionB)).data).toEqual([]);
    const upd = await hostA.client.from("sessions").update({ status: "failed" }).eq("id", sessionB).select();
    expect(upd.data ?? []).toHaveLength(0);
  });

  it("hosts cannot move a session to another host", async () => {
    const r = await hostA.client.from("sessions").update({ host_id: hostB.id }).eq("id", sessionA);
    expect(r.error).not.toBeNull();
  });

  it("hosts cannot start pairings", async () => {
    expect((await hostA.client.rpc("create_host_pairing", { p_name: "x" })).error).not.toBeNull();
  });

  it("heartbeat updates only the caller's host", async () => {
    const r = await hostA.client.rpc("host_heartbeat", { p_platform: "win32", p_connector_version: "t", p_remote_control_allowed: false });
    expect(r.error).toBeNull();
    const h = await ownerA.client.from("hosts").select("last_seen_at, remote_control_allowed").eq("id", hostA.id).single();
    expect(h.data?.last_seen_at).not.toBeNull();
    expect(h.data?.remote_control_allowed).toBe(false);
    expect((await ownerA.client.rpc("host_heartbeat", { p_platform: "x", p_connector_version: "x", p_remote_control_allowed: true })).error).not.toBeNull();
  });
});

describe("event deduplication", () => {
  it("rejects a duplicate dedupe_key and ignores it on upsert", async () => {
    const ev = { host_id: hostA.id, session_id: sessionA, type: "status_changed", status: "waiting_for_input", dedupe_key: `k-${randomUUID()}` };
    expect((await hostA.client.from("session_events").insert(ev)).error).toBeNull();
    expect((await hostA.client.from("session_events").insert(ev)).error?.code).toBe("23505");
    const up = await hostA.client.from("session_events").upsert(ev, { onConflict: "session_id,dedupe_key", ignoreDuplicates: true });
    expect(up.error).toBeNull();
    const count = await ownerA.client.from("session_events").select("id", { count: "exact", head: true }).eq("dedupe_key", ev.dedupe_key);
    expect(count.count).toBe(1);
  });
});

describe("forged identity", () => {
  it("user_metadata claiming to be a host grants nothing", async () => {
    const email = `forger-${randomUUID()}@test.local`;
    const password = `pw-${randomUUID()}`;
    const anon = anonClient(env);
    const su = await anon.auth.signUp({ email, password, options: { data: { mc_role: "host", host_id: hostA.id } } });
    expect(su.error).toBeNull();
    const forger = await signedIn(env, email, password);
    expect((await forger.from("sessions").select("id")).data).toEqual([]);
    expect((await forger.from("hosts").select("id")).data).toEqual([]);
    const ins = await forger.from("sessions").insert({ ...sessionRow(), host_id: hostA.id });
    expect(ins.error).not.toBeNull();
    // The user cannot grant themselves app_metadata either.
    await forger.auth.updateUser({ data: { mc_role: "host", host_id: hostA.id } });
    const { data } = await forger.auth.refreshSession();
    expect(data.user?.app_metadata?.["mc_role"]).toBeUndefined();
  });
});

describe("pairing", () => {
  it("codes are single-use", async () => {
    const owner = await createOwner(env);
    const { code } = await startPairing(owner);
    expect((await redeem(env, code)).status).toBe(200);
    expect((await redeem(env, code)).status).toBe(400);
  });

  it("rejects malformed and unknown codes without detail", async () => {
    expect((await redeem(env, "not-a-code")).status).toBe(400);
    const r = await redeem(env, "ZZZZ-ZZZZ-ZZZZ");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_or_expired_code" });
  });

  it("validates host names and limits pending pairings", async () => {
    const owner = await createOwner(env);
    expect((await owner.client.rpc("create_host_pairing", { p_name: "   " })).error).not.toBeNull();
    for (let i = 0; i < 5; i++) await startPairing(owner, `pending ${i}`);
    expect((await owner.client.rpc("create_host_pairing", { p_name: "sixth" })).error).not.toBeNull();
  });

  it("revoked hosts cannot pair", async () => {
    const owner = await createOwner(env);
    const { code, host_id } = await startPairing(owner);
    await owner.client.from("hosts").update({ revoked_at: new Date().toISOString() }).eq("id", host_id);
    expect((await redeem(env, code)).status).toBe(400);
  });
});

describe("revocation", () => {
  it("takes effect immediately for writes and reads, and cannot be undone", async () => {
    const owner = await createOwner(env);
    const host = await pairHost(env, owner);
    const s = await host.client.from("sessions").insert({ ...sessionRow(), host_id: host.id }).select("id").single();
    expect(s.error).toBeNull();

    const rev = await owner.client.from("hosts").update({ revoked_at: new Date().toISOString() }).eq("id", host.id).select();
    expect(rev.data).toHaveLength(1);

    // Same (still unexpired) JWT, but the host row is revoked.
    expect((await host.client.from("sessions").insert({ ...sessionRow(), host_id: host.id })).error).not.toBeNull();
    expect((await host.client.from("sessions").select("id")).data).toEqual([]);
    expect((await host.client.rpc("host_heartbeat", { p_platform: "x", p_connector_version: "x", p_remote_control_allowed: null })).error).not.toBeNull();

    const undo = await owner.client.from("hosts").update({ revoked_at: null }).eq("id", host.id);
    expect(undo.error).not.toBeNull();
  });
});

describe("realtime", () => {
  it("delivers changes only to the owning user", async () => {
    const received: Record<"a" | "b", string[]> = { a: [], b: [] };
    const subscribe = (owner: Owner, key: "a" | "b") =>
      new Promise<void>((resolve, reject) => {
        void owner.client.realtime.setAuth();
        owner.client
          .channel(`rt-${key}-${randomUUID()}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (p) => {
            received[key].push((p.new as { external_id?: string }).external_id ?? "");
          })
          .subscribe((status) => {
            if (status === "SUBSCRIBED") resolve();
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(status));
          });
      });
    await Promise.all([subscribe(ownerA, "a"), subscribe(ownerB, "b")]);

    const ext = `rt-${randomUUID()}`;
    const ins = await hostA.client.from("sessions").insert({ ...sessionRow(ext), host_id: hostA.id });
    expect(ins.error).toBeNull();
    await new Promise((r) => setTimeout(r, 3000));

    expect(received.a).toContain(ext);
    expect(received.b).not.toContain(ext);
    await ownerA.client.removeAllChannels();
    await ownerB.client.removeAllChannels();
  });
});
