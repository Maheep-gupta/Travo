import type { SessionStatus, SessionUpsert } from "@mc/contracts";
import { HEARTBEAT_INTERVAL_MS, effectiveCapabilities, diffObservations, transcriptContentDecision } from "@mc/domain";
import type { EventInput, KnownSession, MessageInput, Provider, Transport } from "./types.js";

/**
 * "provider_error": the backend is reachable but the session source failed
 * (e.g. the CLI is missing, timed out or printed something unparseable).
 * Kept apart from "offline" so a local tool problem is never reported as the
 * backend being down, and so heartbeats keep the host online meanwhile.
 */
export type ConnectionState = "starting" | "online" | "offline" | "provider_error";

/** A failure of the provider (session source), as opposed to the transport. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

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

/**
 * Consecutive cycles in which session writes didn't land, although the
 * heartbeat did, before the heartbeat reports the source as not responding.
 * Either the backend skipped rows because it holds newer observations (this
 * machine's clock is behind, or another connector writes for this host), or
 * the writes failed outright. The host still looks online, so without this the
 * dashboard would show the frozen statuses as current.
 */
export const SKIPPED_WRITES_LIMIT = 3;

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
  private providerFailingSince: Date | null = null;
  /** Source health as last reported to the backend; null = not reported yet. */
  private reportedProviderOk: boolean | null = null;
  private skippedCycles = 0;
  private heartbeatSentThisCycle = false;
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
      const secondsSince = (since: Date) => Math.round((now.getTime() - since.getTime()) / 1000);
      if (this.state === "provider_error" && this.providerFailingSince) {
        this.log(`provider recovered: ${this.opts.provider.id} after ${secondsSince(this.providerFailingSince)}s`);
      } else if (this.state !== "online") {
        const after = this.offlineSince ? ` after ${secondsSince(this.offlineSince)}s offline` : "";
        this.log(`online: connected to ${this.opts.transport.backendUrl}${after}`);
      }
      this.state = "online";
      this.failures = 0;
      this.offlineSince = null;
      this.providerFailingSince = null;
      return this.pollMs;
    } catch (e) {
      this.failures += 1;
      // The heartbeat went through but the writes didn't: the host looks
      // online while its statuses freeze. A full outage (heartbeat failed) or a
      // provider failure (already reported) doesn't count.
      if (!(e instanceof ProviderError) && this.heartbeatSentThisCycle) this.noteUntrustedWrites("failed");
      if (e instanceof ProviderError) {
        // The backend is fine: no forced heartbeat, nothing written, nothing marked ended.
        if (this.state !== "provider_error") {
          this.providerFailingSince = now;
          this.log(`provider error: ${e.message}`);
        }
        this.state = "provider_error";
        return backoffDelay(this.failures, this.pollMs);
      }
      if (this.state !== "offline") {
        this.offlineSince = now;
        this.log(`offline: ${(e as Error).message}`);
      }
      this.state = "offline";
      // Force a heartbeat (and a fresh health report) as soon as we are back.
      this.lastHeartbeat = 0;
      this.reportedProviderOk = null;
      return backoffDelay(this.failures, this.pollMs);
    }
  }

  private noteUntrustedWrites(what: string): void {
    if (++this.skippedCycles === SKIPPED_WRITES_LIMIT) {
      this.log(`session writes ${what} ${SKIPPED_WRITES_LIMIT} cycles in a row; reporting the source as not responding (check this machine's clock, or whether another connector runs for this host)`);
    }
  }

  private async sync(now: Date): Promise<void> {
    const { provider, transport } = this.opts;
    this.heartbeatSentThisCycle = false;
    if (!this.loadedKnown) {
      this.known = await transport.loadKnownSessions(provider.id);
      this.loadedKnown = true;
    }

    // Read the source first so the heartbeat can report its health.
    let observed: Awaited<ReturnType<Provider["poll"]>> = [];
    let providerError: ProviderError | null = null;
    try {
      observed = await provider.poll();
    } catch (e) {
      // Provider errors are already sanitised (no command output); keep only the message.
      providerError = new ProviderError(`${provider.id}: ${e instanceof Error ? e.message : "unknown error"}`);
    }

    // Heartbeat on schedule, and immediately when source health changes, so the
    // dashboard stops trusting (or trusts again) this host's statuses within a cycle.
    const writesTrusted = this.skippedCycles < SKIPPED_WRITES_LIMIT;
    const providerOk = providerError === null && writesTrusted;
    if (now.getTime() - this.lastHeartbeat >= HEARTBEAT_INTERVAL_MS || providerOk !== this.reportedProviderOk) {
      await transport.heartbeat({
        platform: this.opts.platform,
        connector_version: this.opts.version,
        remote_control_allowed: this.opts.remoteControlAllowed,
        provider_ok: providerOk,
      });
      this.lastHeartbeat = now.getTime();
      this.reportedProviderOk = providerOk;
      this.heartbeatSentThisCycle = true;
    }
    if (providerError) throw providerError;
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
      observed_at: now.toISOString(),
    }));
    // Sessions that disappeared are marked ended (never "completed").
    // Every write carries this cycle's observation time. The backend skips a row
    // when it already holds a newer observation (e.g. from an overlapping
    // connector process); such rows are missing from `ids`, so they get no
    // event, no messages and no `known` update, and the next cycle retries.
    const endedIds = transitions.filter((t) => t.type === "session_ended").map((t) => t.external_id);
    const ids = await transport.upsertSessions(rows);
    const skipped = rows.filter((r) => !ids.has(r.external_id)).length;
    if (skipped === 0) {
      if (!writesTrusted) this.log("session writes accepted again");
      this.skippedCycles = 0;
    } else {
      if (this.skippedCycles === 0) this.log(`backend kept newer observations for ${skipped} session(s); skipped`);
      this.noteUntrustedWrites("skipped");
    }
    const endedApplied: string[] = [];
    for (const externalId of endedIds) {
      if (!this.known.has(externalId)) continue;
      const kept = await transport.upsertSessions([
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
          observed_at: now.toISOString(),
        },
      ]);
      const id = kept.get(externalId);
      if (!id) continue;
      ids.set(externalId, id);
      endedApplied.push(externalId);
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
    for (const externalId of endedApplied) {
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
