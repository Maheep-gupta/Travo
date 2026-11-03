// What the Supabase implementation subscribes to (security review M5). The
// client is faked: this checks the subscription request, not Realtime's
// delivery or authorization (supabase/tests/rls.test.ts, unrun: Docker).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../src/storage.js";
import { REALTIME_TOPIC_PREFIX, createSupabaseApi } from "../src/supabase-api.js";

interface Binding {
  type: string;
  filter: Record<string, unknown>;
  callback: () => void;
}

interface FakeChannel {
  topic: string;
  options: unknown;
  bindings: Binding[];
  subscribed: number;
  /** The status callback realtime-js would call. */
  onStatus: ((status: string) => void) | null;
}

const fake = vi.hoisted(() => ({ channels: [] as FakeChannel[], removed: [] as FakeChannel[] }));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: () => ({
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }) },
      channel: (topic: string, options?: unknown) => {
        const ch: FakeChannel = { topic, options, bindings: [], subscribed: 0, onStatus: null };
        fake.channels.push(ch);
        const api = {
          on(type: string, filter: Record<string, unknown>, callback: () => void) {
            ch.bindings.push({ type, filter, callback });
            return api;
          },
          subscribe(onStatus?: (status: string) => void) {
            ch.onStatus = onStatus ?? null;
            ch.subscribed += 1;
            return api;
          },
          ch,
        };
        return api;
      },
      removeChannel: (c: { ch: FakeChannel }) => {
        fake.removed.push(c.ch);
        return Promise.resolve("ok");
      },
    }),
  };
});

beforeEach(() => {
  fake.channels.length = 0;
  fake.removed.length = 0;
});

const makeApi = () => createSupabaseApi({ url: "https://example.supabase.co", publishableKey: "sb_publishable_0123456789abcdef" }, new MemoryStorage());

describe("subscribe (Supabase)", () => {
  it("listens only to INSERT and UPDATE on sessions and session_events, on one private channel", () => {
    const off = makeApi().subscribe(() => undefined);
    expect(fake.channels).toHaveLength(1);
    const [ch] = fake.channels;
    expect(ch?.options).toEqual({ config: { private: true } });
    expect(ch?.topic.startsWith(REALTIME_TOPIC_PREFIX)).toBe(true);
    expect(ch?.topic.length).toBeGreaterThan(REALTIME_TOPIC_PREFIX.length);
    expect(ch?.subscribed).toBe(1);
    const filters = (ch?.bindings ?? []).map((b) => ({ type: b.type, event: b.filter["event"], schema: b.filter["schema"], table: b.filter["table"] }));
    expect(filters).toEqual([
      { type: "postgres_changes", event: "INSERT", schema: "public", table: "sessions" },
      { type: "postgres_changes", event: "UPDATE", schema: "public", table: "sessions" },
      { type: "postgres_changes", event: "INSERT", schema: "public", table: "session_events" },
      { type: "postgres_changes", event: "UPDATE", schema: "public", table: "session_events" },
    ]);
    // Never DELETE (not RLS-filtered), never a wildcard, never hosts or transcripts.
    for (const f of filters) {
      expect(["INSERT", "UPDATE"]).toContain(f.event);
      expect(["hosts", "session_messages"]).not.toContain(f.table);
    }
    off();
  });

  it("reports the changed table, and unsubscribing removes the channel", () => {
    const topics: string[] = [];
    const off = makeApi().subscribe((t) => topics.push(t));
    for (const b of fake.channels[0]?.bindings ?? []) b.callback();
    expect(topics).toEqual(["sessions", "sessions", "session_events", "session_events"]);
    off();
    expect(fake.removed).toEqual([fake.channels[0]]);
  });

  it("gives each subscription its own topic (realtime-js reuses a channel with the same topic)", () => {
    const api = makeApi();
    api.subscribe(() => undefined);
    api.subscribe(() => undefined);
    expect(fake.channels).toHaveLength(2);
    expect(fake.channels[0]?.topic).not.toBe(fake.channels[1]?.topic);
  });
});

describe("liveUpdates (Supabase)", () => {
  it("reports the join state of the latest subscription, without error details", () => {
    const api = makeApi();
    const live = api.liveUpdates;
    if (!live) throw new Error("liveUpdates missing");
    const changes = vi.fn();
    const stop = live.onChange(changes);
    expect(live.status()).toBeNull();

    const off = api.subscribe(() => undefined);
    const ch = fake.channels[0];
    expect(live.status()).toBe("connecting");
    ch?.onStatus?.("SUBSCRIBED");
    expect(live.status()).toBe("on");
    // A failed private-channel join (e.g. the realtime policy not applied) or a timeout.
    ch?.onStatus?.("CHANNEL_ERROR");
    expect(live.status()).toBe("unavailable");
    ch?.onStatus?.("SUBSCRIBED");
    ch?.onStatus?.("TIMED_OUT");
    expect(live.status()).toBe("unavailable");
    expect(changes).toHaveBeenCalledTimes(5);

    // Unsubscribing forgets it; the CLOSED that removal causes isn't reported as a failure.
    off();
    expect(live.status()).toBeNull();
    ch?.onStatus?.("CLOSED");
    expect(live.status()).toBeNull();
    stop();
  });

  it("ignores an older subscription once a newer one exists", () => {
    const api = makeApi();
    api.subscribe(() => undefined);
    api.subscribe(() => undefined);
    fake.channels[1]?.onStatus?.("SUBSCRIBED");
    fake.channels[0]?.onStatus?.("CHANNEL_ERROR");
    expect(api.liveUpdates?.status()).toBe("on");
  });
});
