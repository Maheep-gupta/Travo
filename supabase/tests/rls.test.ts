import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
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
    expect(meta.data?.schema_version).toBe(3);
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
    const r = await hostA.client.rpc("host_heartbeat", { p_platform: "win32", p_connector_version: "t", p_remote_control_allowed: false, p_provider_ok: true });
    expect(r.error).toBeNull();
    const h = await ownerA.client.from("hosts").select("last_seen_at, remote_control_allowed").eq("id", hostA.id).single();
    expect(h.data?.last_seen_at).not.toBeNull();
    expect(h.data?.remote_control_allowed).toBe(false);
    // 42501 specifically: the call must reach the function and be refused, not fail on a missing signature.
    const denied = await ownerA.client.rpc("host_heartbeat", { p_platform: "x", p_connector_version: "x", p_remote_control_allowed: true, p_provider_ok: true });
    expect(denied.error?.code).toBe("42501");
  });

  it("source health (schema v2) is set and cleared only through the heartbeat, keeping the failure start", async () => {
    const beat = (ok: boolean) =>
      hostA.client.rpc("host_heartbeat", { p_platform: "win32", p_connector_version: "t", p_remote_control_allowed: false, p_provider_ok: ok });
    const since = async () => (await ownerA.client.from("hosts").select("provider_error_since").eq("id", hostA.id).single()).data?.provider_error_since as string | null;

    expect((await beat(false)).error).toBeNull();
    const first = await since();
    expect(first).not.toBeNull();
    expect((await beat(false)).error).toBeNull();
    expect(await since()).toBe(first); // ongoing failure keeps its start
    expect((await beat(true)).error).toBeNull();
    expect(await since()).toBeNull();

    // A missing health value is rejected rather than treated as healthy.
    const missing = await hostA.client.rpc("host_heartbeat", { p_platform: "x", p_connector_version: "x", p_remote_control_allowed: false, p_provider_ok: null });
    expect(missing.error).not.toBeNull();
    // The v1 signature no longer exists.
    expect((await hostA.client.rpc("host_heartbeat", { p_platform: "x", p_connector_version: "x", p_remote_control_allowed: false })).error).not.toBeNull();
  });

  it("nobody can write provider_error_since directly", async () => {
    const owner = await ownerA.client.from("hosts").update({ provider_error_since: new Date().toISOString() }).eq("id", hostA.id).select("id");
    expect(owner.error).not.toBeNull(); // no column UPDATE grant
    const host = await hostA.client.from("hosts").update({ provider_error_since: null }).eq("id", hostA.id).select("id");
    expect(host.error ?? (host.data?.length === 0 ? null : "updated")).not.toBe("updated");
  });

  it("another owner cannot see a host's source health", async () => {
    const r = await ownerB.client.from("hosts").select("provider_error_since").eq("id", hostA.id);
    expect(r.data ?? []).toHaveLength(0);
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

describe("stale-write guard (schema v3)", () => {
  // Observation times well in the past, so the local stack's clock can't interfere.
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const upsert = (row: ReturnType<typeof sessionRow>) =>
    hostA.client.from("sessions").upsert({ ...row, host_id: hostA.id }, { onConflict: "host_id,provider,external_id" }).select("id, status");
  const stored = async (ext: string) =>
    (await ownerA.client.from("sessions").select("status, observed_at, updated_at").eq("external_id", ext).single()).data as
      | { status: string; observed_at: string; updated_at: string }
      | null;

  it("skips an older write without an error and without returning the row", async () => {
    const ext = `stale-${randomUUID()}`;
    expect((await upsert({ ...sessionRow(ext, at(10)), status: "approval_required" })).error).toBeNull();
    const before = await stored(ext);

    const late = await upsert({ ...sessionRow(ext, at(20)), status: "running" });
    expect(late.error).toBeNull(); // the connector's batch must not fail
    expect(late.data ?? []).toHaveLength(0); // absent from RETURNING, so the connector records no event
    const patch = await hostA.client.from("sessions").update({ status: "failed", observed_at: at(30) }).eq("external_id", ext).select("id");
    expect(patch.error).toBeNull();
    expect(patch.data ?? []).toHaveLength(0);
    expect(await stored(ext)).toEqual(before); // status, observation time and updated_at untouched
  });

  it("applies an equal observation idempotently", async () => {
    const ext = `equal-${randomUUID()}`;
    const row = { ...sessionRow(ext, at(10)), status: "waiting_for_input" };
    const first = await upsert(row);
    const again = await upsert(row);
    expect(first.error).toBeNull();
    expect(again.error).toBeNull();
    expect(again.data?.[0]?.id).toBe(first.data?.[0]?.id);
    expect((await stored(ext))?.status).toBe("waiting_for_input");
    const count = await ownerA.client.from("sessions").select("id", { count: "exact", head: true }).eq("external_id", ext);
    expect(count.count).toBe(1);
  });

  it("lets a newer observation win", async () => {
    const ext = `newer-${randomUUID()}`;
    expect((await upsert(sessionRow(ext, at(10)))).error).toBeNull();
    const next = await upsert({ ...sessionRow(ext, at(5)), status: "completed" });
    expect(next.error).toBeNull();
    expect(next.data).toHaveLength(1);
    expect((await stored(ext))?.status).toBe("completed");
  });

  it("clamps far-future observation times to five minutes ahead", async () => {
    const ext = `future-${randomUUID()}`;
    const before = Date.now();
    expect((await upsert(sessionRow(ext, new Date(before + 86_400_000).toISOString()))).error).toBeNull();
    const clamped = Date.parse((await stored(ext))?.observed_at ?? "");
    // Allow a little drift between the test process and the database clock.
    expect(clamped).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 30_000);
    expect(clamped).toBeGreaterThan(before + 4 * 60_000);
    // A second far-future write clamps to a later bound, so the session still updates.
    const again = await upsert({ ...sessionRow(ext, new Date(before + 86_400_000).toISOString()), status: "failed" });
    expect(again.error).toBeNull();
    expect((await stored(ext))?.status).toBe("failed");
  });

  it("requires an observation time on every write", async () => {
    const noObservation = Object.fromEntries(Object.entries(sessionRow()).filter(([k]) => k !== "observed_at"));
    const ins = await hostA.client.from("sessions").insert({ ...noObservation, host_id: hostA.id });
    expect(ins.error?.code).toBe("23502");
    const nulled = await hostA.client.from("sessions").update({ observed_at: null }).eq("id", sessionA);
    expect(nulled.error?.code).toBe("23502"); // not turned into now() + 5 min
  });

  it("still refuses to move a session even when the write is stale", async () => {
    const r = await hostA.client.from("sessions").update({ host_id: hostB.id, observed_at: at(60 * 24 * 365) }).eq("id", sessionA);
    // The trigger itself must refuse it (column grants allow host_id since v3).
    expect(r.error?.message).toContain("immutable session columns");
  });

  it("doesn't let another host freeze this host's row with a future observation", async () => {
    const ext = `cross-${randomUUID()}`;
    expect((await upsert(sessionRow(ext, at(10)))).error).toBeNull();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    // Host B targets A's conflict key; RLS must refuse rather than update A's row.
    const forged = await hostB.client
      .from("sessions")
      .upsert({ ...sessionRow(ext, future), host_id: hostA.id }, { onConflict: "host_id,provider,external_id" })
      .select("id");
    expect(forged.error).not.toBeNull();
    expect((await upsert({ ...sessionRow(ext, at(5)), status: "completed" })).data).toHaveLength(1);
  });

  it("still gives owners no write access, whatever the observation time", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const upd = await ownerA.client.from("sessions").update({ status: "failed", observed_at: future }).eq("id", sessionA).select();
    expect(upd.data ?? []).toHaveLength(0);
    const ins = await ownerA.client.from("sessions").insert({ ...sessionRow(randomUUID(), future), host_id: hostA.id });
    expect(ins.error).not.toBeNull();
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
    expect((await host.client.rpc("host_heartbeat", { p_platform: "x", p_connector_version: "x", p_remote_control_allowed: null, p_provider_ok: true })).error?.code).toBe("42501");

    const undo = await owner.client.from("hosts").update({ revoked_at: null }).eq("id", host.id);
    expect(undo.error).not.toBeNull();
  });
});

describe("owner identity fails closed (S4, migration 20261105000001)", () => {
  it("a host claim with a malformed host_id is neither a host nor an owner", async () => {
    // app_metadata can only be set with the secret key: this is the shape of a
    // broken or tampered pair-host user, not something a client can create.
    const email = `malformed-${randomUUID()}@test.local`;
    const password = `pw-${randomUUID()}`;
    const created = await adminClient(env).auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { mc_role: "host", host_id: "not-a-uuid" },
    });
    expect(created.error).toBeNull();
    const c = await signedIn(env, email, password);
    expect((await c.from("hosts").select("id")).data ?? []).toEqual([]);
    expect((await c.from("sessions").select("id")).data ?? []).toEqual([]);
    expect((await c.rpc("create_host_pairing", { p_name: "x" })).error?.code).toBe("42501");
    expect((await c.from("notification_prefs").insert({ owner_id: created.data.user?.id })).error).not.toBeNull();
  });
});

describe("read-only capabilities (S3, D-003)", () => {
  it("refuses control capabilities from a host", async () => {
    for (const cap of ["send_message", "resume", "approve_requests"]) {
      const r = await hostA.client.from("sessions").insert({ ...sessionRow(), capabilities: ["discover", cap], host_id: hostA.id });
      expect(r.error?.code).toBe("23514");
      const u = await hostA.client.from("sessions").update({ capabilities: [cap] }).eq("id", sessionA);
      expect(u.error?.code).toBe("23514");
    }
  });
});

describe("transcript storage gate (S2, D-004)", () => {
  // The local stack is seeded with transcripts_enabled = true (supabase/seed.sql).
  const msg = () => ({ host_id: hostA.id, session_id: sessionA, external_uuid: `gate-${randomUUID()}`, role: "assistant", text: "excerpt" });
  const setEnabled = async (on: boolean) => {
    const r = await adminClient(env).from("app_meta").update({ transcripts_enabled: on }).eq("id", true).select("transcripts_enabled");
    if (r.error || r.data?.length !== 1) throw r.error ?? new Error("app_meta not updated");
  };

  it("is enabled on the seeded local stack", async () => {
    const r = await anonClient(env).from("app_meta").select("transcripts_enabled").single();
    expect(r.data?.transcripts_enabled).toBe(true);
    expect((await hostA.client.from("session_messages").insert(msg())).error).toBeNull();
  });

  it("refuses a host's transcript insert while disabled", async () => {
    await setEnabled(false);
    try {
      const m = msg();
      expect((await hostA.client.from("session_messages").insert(m)).error?.code).toBe("42501");
      expect((await ownerA.client.from("session_messages").select("id").eq("external_uuid", m.external_uuid)).data).toEqual([]);
    } finally {
      await setEnabled(true);
    }
    expect((await hostA.client.from("session_messages").insert(msg())).error).toBeNull();
  });

  it("can't be toggled by an owner, a host or anon", async () => {
    for (const c of [ownerA.client, hostA.client, anonClient(env)]) {
      const r = await c.from("app_meta").update({ transcripts_enabled: false }).eq("id", true).select("id");
      expect(r.error ?? (r.data?.length === 0 ? null : "updated")).not.toBe("updated");
    }
    const r = await anonClient(env).from("app_meta").select("transcripts_enabled").single();
    expect(r.data?.transcripts_enabled).toBe(true);
  });
});

describe("realtime", () => {
  // As the app subscribes (packages/api-client supabase-api.ts `subscribe`):
  // a private channel on a `tavro-changes:` topic, INSERT/UPDATE only.
  const join = (client: Host["client"], topic: string, onInsert: (externalId: string) => void = () => undefined) =>
    new Promise<string>((resolve) => {
      void client.realtime.setAuth();
      client
        .channel(topic, { config: { private: true } })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "sessions" }, (p) => {
          onInsert((p.new as { external_id?: string }).external_id ?? "");
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve(status);
        });
    });

  it("lets owners, but not hosts, join the private changes channel", async () => {
    expect(await join(ownerA.client, `tavro-changes:${randomUUID()}`)).toBe("SUBSCRIBED");
    expect(await join(hostA.client, `tavro-changes:${randomUUID()}`)).toBe("CHANNEL_ERROR");
    expect(await join(ownerA.client, `other-${randomUUID()}`)).toBe("CHANNEL_ERROR");
    await ownerA.client.removeAllChannels();
    await hostA.client.removeAllChannels();
  });

  it("delivers changes only to the owning user", async () => {
    const received: Record<"a" | "b", string[]> = { a: [], b: [] };
    const subscribe = async (owner: Owner, key: "a" | "b") => {
      const status = await join(owner.client, `tavro-changes:${key}-${randomUUID()}`, (ext) => received[key].push(ext));
      if (status !== "SUBSCRIBED") throw new Error(status);
    };
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
