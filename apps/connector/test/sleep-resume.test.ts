// Sleep, resume, restart and redelivery (spec 4.2 "avoid false transitions
// after sleep or network interruption", "recover cleanly after connector
// restart"; Part 16 "laptop sleep and restart"). A sleeping laptop freezes the
// connector between two cycles; the next cycle runs with a wall clock that has
// jumped forward. All clocks here are manual.
import type { SessionUpsert } from "@mc/contracts";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_MS } from "@mc/domain";
import { Connector, SKIPPED_WRITES_LIMIT } from "../src/connector.js";
import { MemoryTransport, TransportUnavailableError } from "../src/transports/memory.js";
import type { Provider, ProviderMessage, ProviderSession } from "../src/types.js";

class ScriptedProvider implements Provider {
  readonly id = "mock" as const;
  readonly isDemo = true;
  current: ProviderSession[] = [];
  async poll() {
    return this.current.map((s) => ({ ...s }));
  }
  async messages(externalId: string): Promise<ProviderMessage[]> {
    return [{ external_uuid: `${externalId}-1`, role: "assistant", text: "(demo) hello", occurred_at: null }];
  }
}

function session(external_id: string, status: ProviderSession["status"]): ProviderSession {
  return { external_id, title: external_id, project_label: "p", status, status_reason: "Simulated", last_activity_at: null, last_event_summary: null, started_at: null };
}

const MINUTE = 60_000;

/** One laptop: a provider, a database (MemoryTransport) and a clock shared by both. */
function laptop(opts: { backendUrl?: string; syncTranscripts?: boolean } = {}) {
  const clock = { t: Date.parse("2026-10-29T12:00:00Z") };
  const provider = new ScriptedProvider();
  const transport = new MemoryTransport(opts.backendUrl, () => new Date(clock.t));
  const logs: string[] = [];
  const start = () =>
    new Connector({
      provider,
      transport,
      platform: "test",
      version: "t",
      remoteControlAllowed: false,
      syncTranscripts: opts.syncTranscripts ?? false,
      pollMs: 5000,
      log: (l) => logs.push(l),
      now: () => new Date(clock.t),
    });
  return { clock, provider, transport, logs, start, advance: (ms: number) => (clock.t += ms) };
}

const eventLog = (t: MemoryTransport) => t.events.map((e) => `${e.type}:${e.status}`);

describe("laptop sleep and resume", () => {
  it("catches up in one cycle: fresh observations, one event per real change, unchanged sessions silent", async () => {
    const { provider, transport, start, advance, clock } = laptop();
    const connector = start();
    provider.current = [session("same", "running"), session("changed", "running"), session("gone", "waiting_for_input")];
    await connector.runOnce();
    const beats = transport.heartbeats.length;

    // Lid closed for 45 minutes. Meanwhile one session changed and one was closed.
    advance(45 * MINUTE);
    provider.current = [session("same", "running"), session("changed", "approval_required")];
    expect(await connector.runOnce()).toBe(5000);

    // A heartbeat goes out at once, so the dashboard sees the host back.
    expect(transport.heartbeats).toHaveLength(beats + 1);
    // Every row carries the post-resume observation, so none is mistaken for a late write.
    for (const row of transport.sessions.values()) expect(row.observed_at).toBe(new Date(clock.t).toISOString());
    expect(transport.sessions.get("mock:same")?.status).toBe("running");
    expect(transport.sessions.get("mock:changed")?.status).toBe("approval_required");
    // A session that disappeared during the sleep is ended, never "completed" (spec 4.1).
    expect(transport.sessions.get("mock:gone")?.status).toBe("ended");
    expect(eventLog(transport)).toEqual([
      "session_discovered:running",
      "session_discovered:running",
      "session_discovered:waiting_for_input",
      "status_changed:approval_required",
      "session_ended:ended",
    ]);

    // The cycles after resume add nothing.
    for (let i = 0; i < 3; i++) {
      advance(5000);
      await connector.runOnce();
    }
    expect(transport.events).toHaveLength(5);
    expect(transport.heartbeats.every((h) => h.provider_ok)).toBe(true);
  });

  it("recovers when the lid closed mid-cycle (heartbeat sent, writes lost) without reporting the source as failing", async () => {
    const { provider, transport, start, advance, logs } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    // Next cycle: the heartbeat lands, then the machine sleeps and the write's socket is dead on resume.
    provider.current = [session("a", "waiting_for_input")];
    advance(HEARTBEAT_INTERVAL_MS);
    const upsert = transport.upsertSessions.bind(transport);
    transport.upsertSessions = async () => {
      advance(20 * MINUTE);
      throw new TransportUnavailableError("socket closed during sleep");
    };
    const delay = await connector.runOnce();
    expect(connector.connectionState).toBe("offline");
    transport.upsertSessions = upsert;

    advance(delay);
    await connector.runOnce();
    expect(connector.connectionState).toBe("online");
    expect(eventLog(transport)).toEqual(["session_discovered:running", "status_changed:waiting_for_input"]);
    // One lost write is not "the source isn't responding".
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true, true, true]);
    expect(logs.some((l) => l.includes("not responding"))).toBe(false);
  });

  it("doesn't skip writes when the clock is corrected backwards by less than a poll after resume", async () => {
    const { provider, transport, start, advance } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    // The clock ran 3 s fast across the sleep; time sync pulls it back right after the first cycle.
    advance(10 * MINUTE + 3000);
    provider.current = [session("a", "waiting_for_input")];
    await connector.runOnce();
    advance(5000 - 3000);
    provider.current = [session("a", "approval_required")];
    await connector.runOnce();
    expect(transport.sessions.get("mock:a")?.status).toBe("approval_required");
    expect(eventLog(transport)).toEqual(["session_discovered:running", "status_changed:waiting_for_input", "status_changed:approval_required"]);
    expect(transport.heartbeats.every((h) => h.provider_ok)).toBe(true);
  });

  it("reports the source only after SKIPPED_WRITES_LIMIT cycles when the clock was stepped far back on resume", async () => {
    // D-015 by design: the rows written with the fast clock win until real time catches up.
    const { provider, transport, start, advance } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    advance(2 * MINUTE); // the fast clock
    await connector.runOnce();
    advance(-2 * MINUTE); // stepped back
    for (let i = 0; i < SKIPPED_WRITES_LIMIT - 1; i++) {
      advance(5000);
      await connector.runOnce();
    }
    expect(transport.heartbeats.map((h) => h.provider_ok)).toEqual([true]);
  });
});

describe("connector restart", () => {
  it("resumes from the database: no duplicate events, no false transitions, disappeared sessions ended", async () => {
    const { provider, transport, start, advance } = laptop();
    const first = start();
    provider.current = [session("same", "running"), session("changed", "running"), session("gone", "running"), session("done", "running")];
    await first.runOnce();
    provider.current = [session("same", "running"), session("changed", "running"), session("gone", "running")];
    advance(5000);
    await first.runOnce(); // "done" is ended
    first.stop();
    const before = eventLog(transport);

    // Down for 10 minutes; the new process starts with empty memory.
    advance(10 * MINUTE);
    provider.current = [session("same", "running"), session("changed", "failed"), session("new", "running")];
    const second = start();
    await second.runOnce();
    expect(eventLog(transport).slice(before.length)).toEqual(["status_changed:failed", "session_discovered:running", "session_ended:ended"]);
    expect(transport.sessions.get("mock:gone")?.status).toBe("ended");
    expect(transport.sessions.get("mock:gone")?.status_source).toBe("derived");
    // The session that had already ended isn't ended a second time.
    expect(transport.events.filter((e) => e.type === "session_ended")).toHaveLength(2);

    advance(5000);
    await second.runOnce();
    expect(transport.events).toHaveLength(before.length + 3);
  });

  it("doesn't rediscover sessions on restart", async () => {
    const { provider, transport, start, advance } = laptop();
    provider.current = [session("a", "running")];
    await start().runOnce();
    advance(MINUTE);
    await start().runOnce();
    expect(eventLog(transport)).toEqual(["session_discovered:running"]);
  });
});

describe("delayed and duplicate deliveries", () => {
  it("doesn't duplicate a status event whose write landed but whose response was lost", async () => {
    const { provider, transport, start, advance } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    provider.current = [session("a", "waiting_for_input")];
    advance(5000);
    const insert = transport.insertEvents.bind(transport);
    transport.insertEvents = async (events) => {
      await insert(events); // stored...
      throw new TransportUnavailableError("response lost"); // ...but the connector never hears back
    };
    await connector.runOnce();
    transport.insertEvents = insert;

    advance(10_000);
    await connector.runOnce();
    advance(5000);
    await connector.runOnce();
    expect(eventLog(transport)).toEqual(["session_discovered:running", "status_changed:waiting_for_input"]);
    // Recorded at the time the change was first observed.
    expect(transport.events.at(-1)?.occurred_at).toBe("2026-10-29T12:00:05.000Z");
  });

  it("doesn't duplicate a status event when a later write of the same cycle failed", async () => {
    const { provider, transport, start, advance } = laptop({ backendUrl: "http://127.0.0.1:54321", syncTranscripts: true });
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    provider.current = [session("a", "approval_required")];
    advance(5000);
    const insert = transport.insertMessages.bind(transport);
    transport.insertMessages = async () => {
      throw new TransportUnavailableError();
    };
    await connector.runOnce();
    transport.insertMessages = insert;
    advance(10_000);
    await connector.runOnce();
    expect(eventLog(transport)).toEqual(["session_discovered:running", "status_changed:approval_required"]);
  });

  it("doesn't duplicate an end event whose response was lost", async () => {
    const { provider, transport, start, advance } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    provider.current = [];
    advance(5000);
    const insert = transport.insertEvents.bind(transport);
    transport.insertEvents = async (events) => {
      await insert(events);
      throw new TransportUnavailableError("response lost");
    };
    await connector.runOnce();
    transport.insertEvents = insert;
    advance(10_000);
    await connector.runOnce();
    expect(eventLog(transport)).toEqual(["session_discovered:running", "session_ended:ended"]);
    expect(transport.sessions.get("mock:a")?.status).toBe("ended");
  });

  it("records a new change normally after a lost response for an earlier one", async () => {
    const { provider, transport, start, advance } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();

    provider.current = [session("a", "waiting_for_input")];
    advance(5000);
    const insert = transport.insertEvents.bind(transport);
    transport.insertEvents = async (events) => {
      await insert(events);
      throw new TransportUnavailableError("response lost");
    };
    await connector.runOnce();
    transport.insertEvents = insert;
    // By the retry the session has moved on: that is a different, real change.
    provider.current = [session("a", "approval_required")];
    advance(10_000);
    await connector.runOnce();
    provider.current = [session("a", "waiting_for_input")];
    advance(5000);
    await connector.runOnce();
    expect(eventLog(transport)).toEqual([
      "session_discovered:running",
      "status_changed:waiting_for_input",
      "status_changed:approval_required",
      "status_changed:waiting_for_input",
    ]);
  });

  it("ignores a redelivered event batch", async () => {
    const { provider, transport, start } = laptop();
    const insert = transport.insertEvents.bind(transport);
    transport.insertEvents = async (events) => {
      await insert(events);
      await insert(events); // e.g. a retried request
    };
    provider.current = [session("a", "running")];
    await start().runOnce();
    expect(eventLog(transport)).toEqual(["session_discovered:running"]);
  });

  it("an older upsert delivered after a newer one leaves the newer status and adds no event", async () => {
    const { provider, transport, start, advance } = laptop();
    const connector = start();
    provider.current = [session("a", "running")];
    await connector.runOnce();
    // A delayed request from before the sleep arrives after the post-resume one.
    const stored = transport.sessions.get("mock:a");
    if (!stored) throw new Error("missing row");
    const late: SessionUpsert = { ...stored, status: "failed", observed_at: "2026-10-29T11:59:00.000Z" };
    advance(5000);
    provider.current = [session("a", "waiting_for_input")];
    await connector.runOnce();
    expect((await transport.upsertSessions([late])).has("a")).toBe(false);
    expect(transport.sessions.get("mock:a")?.status).toBe("waiting_for_input");
    advance(5000);
    await connector.runOnce();
    expect(eventLog(transport)).toEqual(["session_discovered:running", "status_changed:waiting_for_input"]);
  });
});
