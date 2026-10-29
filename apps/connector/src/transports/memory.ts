import { randomUUID } from "node:crypto";
import type { HeartbeatInput, ProviderId, SessionUpsert } from "@mc/contracts";
import type { EventInput, KnownSession, MessageInput, Transport } from "../types.js";

export class TransportUnavailableError extends Error {
  constructor(message = "backend unreachable (simulated)") {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

/**
 * In-memory transport for the offline demo and tests. `available` can be
 * toggled to simulate network loss.
 */
export class MemoryTransport implements Transport {
  readonly backendUrl: string;
  available = true;
  readonly heartbeats: HeartbeatInput[] = [];
  readonly sessions = new Map<string, SessionUpsert & { id: string }>();
  readonly events: (EventInput & { id: number })[] = [];
  readonly messages: MessageInput[] = [];
  private eventId = 0;

  constructor(backendUrl = "memory://local") {
    this.backendUrl = backendUrl;
  }

  private check(): void {
    if (!this.available) throw new TransportUnavailableError();
  }

  async heartbeat(input: HeartbeatInput): Promise<void> {
    this.check();
    this.heartbeats.push(input);
  }

  async loadKnownSessions(provider: ProviderId): Promise<Map<string, KnownSession>> {
    this.check();
    const out = new Map<string, KnownSession>();
    for (const s of this.sessions.values()) if (s.provider === provider) out.set(s.external_id, { id: s.id, status: s.status });
    return out;
  }

  async upsertSessions(rows: SessionUpsert[]): Promise<Map<string, string>> {
    this.check();
    const ids = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.provider}:${row.external_id}`;
      const id = this.sessions.get(key)?.id ?? randomUUID();
      this.sessions.set(key, { ...row, id });
      ids.set(row.external_id, id);
    }
    return ids;
  }

  async insertEvents(events: EventInput[]): Promise<void> {
    this.check();
    for (const e of events) {
      if (this.events.some((x) => x.session_id === e.session_id && x.dedupe_key === e.dedupe_key)) continue;
      this.events.push({ ...e, id: ++this.eventId });
    }
  }

  async insertMessages(messages: MessageInput[]): Promise<void> {
    this.check();
    for (const m of messages) {
      if (this.messages.some((x) => x.session_id === m.session_id && x.external_uuid === m.external_uuid)) continue;
      this.messages.push(m);
    }
  }
}
