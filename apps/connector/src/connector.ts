import type { SessionStatus, SessionUpsert } from "@mc/contracts";
import { HEARTBEAT_INTERVAL_MS, effectiveCapabilities, diffObservations, transcriptContentDecision } from "@mc/domain";
import type { EventInput, KnownSession, MessageInput, Provider, Transport } from "./types.js";

export type ConnectionState = "starting" | "online" | "offline";

export interface ConnectorOptions {
  provider: Provider;
  transport: Transport;
  platform: string;
  version: string;
  /** From the host's Claude policy; null if unknown. Control stays disabled either way in this release. */
  remoteControlAllowed: boolean | null;
  syncTranscripts: boolean;
  pollMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export const MAX_BACKOFF_MS = 60_000;

/** Exponential backoff with full jitter, capped. `failures` >= 1. */
export function backoffDelay(failures: number, baseMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(failures - 1, 10));
  return Math.max(baseMs, Math.floor(random() * ceiling));
}

/**
 * Polls a provider, turns observations into session rows and status events,
 * and writes them through the transport. Commands are never accepted: the
 * connector has no inbound interface at all in this release.
 */
export class Connector {
  private state: ConnectionState = "starting";
  private known = new Map<string, KnownSession>();
  private loadedKnown = false;
  private failures = 0;
  private lastHeartbeat = 0;
  private offlineSince: Date | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly pollMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly opts: ConnectorOptions) {
    this.pollMs = opts.pollMs ?? 5000;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? (() => new Date());
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** One poll + sync cycle. Returns the delay before the next cycle. */
  async runOnce(): Promise<number> {
    const now = this.now();
    try {
      await this.sync(now);
      if (this.state !== "online") {
        const after = this.offlineSince ? ` after ${Math.round((now.getTime() - this.offlineSince.getTime()) / 1000)}s offline` : "";
        this.log(`online: connected to ${this.opts.transport.backendUrl}${after}`);
      }
      this.state = "online";
      this.failures = 0;
      this.offlineSince = null;
      return this.pollMs;
    } catch (e) {
      this.failures += 1;
      if (this.state !== "offline") {
        this.offlineSince = now;
        this.log(`offline: ${(e as Error).message}`);
      }
      this.state = "offline";
      // Force a heartbeat as soon as we are back.
      this.lastHeartbeat = 0;
      return backoffDelay(this.failures, this.pollMs);
    }
  }

  private async sync(now: Date): Promise<void> {
    const { provider, transport } = this.opts;
    if (!this.loadedKnown) {
      this.known = await transport.loadKnownSessions(provider.id);
      this.loadedKnown = true;
    }

    if (now.getTime() - this.lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      await transport.heartbeat({
        platform: this.opts.platform,
        connector_version: this.opts.version,
        remote_control_allowed: this.opts.remoteControlAllowed,
      });
      this.lastHeartbeat = now.getTime();
    }

    const observed = await provider.poll();
    const previous = new Map<string, SessionStatus>([...this.known].map(([k, v]) => [k, v.status]));
    const transitions = diffObservations(previous, observed, now);
    const capabilities = effectiveCapabilities(provider.id, {
      remoteControlAllowed: this.opts.remoteControlAllowed,
      repliesEnabled: false,
    });

    const rows: SessionUpsert[] = observed.map((o) => ({
      provider: provider.id,
      external_id: o.external_id,
      title: o.title,
      project_label: o.project_label,
      status: o.status,
      status_reason: o.status_reason,
      status_source: provider.isDemo ? "mock" : "cli_agents_list",
      last_activity_at: o.last_activity_at,
      last_event_summary: o.last_event_summary,
      capabilities,
      is_demo: provider.isDemo,
      started_at: o.started_at,
      ended_at: null,
    }));
    // Sessions that disappeared are marked ended (never "completed").
    const endedIds = transitions.filter((t) => t.type === "session_ended").map((t) => t.external_id);
    const ids = await transport.upsertSessions(rows);
    for (const externalId of endedIds) {
      const k = this.known.get(externalId);
      if (!k) continue;
      await transport.upsertSessions([
        {
          provider: provider.id,
          external_id: externalId,
          title: null,
          project_label: null,
          status: "ended",
          status_reason: "The session is no longer listed by the provider.",
          status_source: "derived",
          last_activity_at: now.toISOString(),
          last_event_summary: null,
          capabilities: [],
          is_demo: provider.isDemo,
          started_at: null,
          ended_at: now.toISOString(),
        },
      ]);
      ids.set(externalId, k.id);
    }

    const events: EventInput[] = [];
    for (const t of transitions) {
      const sessionId = ids.get(t.external_id);
      if (!sessionId) continue;
      events.push({
        session_id: sessionId,
        type: t.type,
        status: t.status,
        summary: t.type === "session_ended" ? "Session closed" : (observed.find((o) => o.external_id === t.external_id)?.last_event_summary ?? null),
        dedupe_key: t.dedupe_key,
        is_demo: provider.isDemo,
        occurred_at: now.toISOString(),
      });
    }
    await transport.insertEvents(events);

    const content = transcriptContentDecision(transport.backendUrl, this.opts.syncTranscripts);
    if (content.allowed && provider.messages) {
      const changed = new Set(transitions.map((t) => t.external_id));
      const messages: MessageInput[] = [];
      for (const o of observed) {
        const sessionId = ids.get(o.external_id);
        if (!sessionId || !changed.has(o.external_id)) continue;
        for (const m of (await provider.messages(o.external_id)).slice(-20)) {
          messages.push({ ...m, session_id: sessionId, text: m.text.slice(0, 4000) });
        }
      }
      await transport.insertMessages(messages);
    }

    // Commit only after every write succeeded, so a failed cycle is retried in full.
    for (const o of observed) {
      const id = ids.get(o.external_id);
      if (id) this.known.set(o.external_id, { id, status: o.status });
    }
    for (const externalId of endedIds) {
      const k = this.known.get(externalId);
      if (k) this.known.set(externalId, { ...k, status: "ended" });
    }
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      const delay = await this.runOnce();
      if (!this.stopped) this.timer = setTimeout(() => void loop(), delay);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
