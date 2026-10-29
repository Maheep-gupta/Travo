import { DEFAULT_NOTIFICATION_PREFS, MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import type {
  HostRow,
  NotificationPrefs,
  SessionEventRow,
  SessionMessageRow,
  SessionRow,
  SessionStatus,
} from "@mc/contracts";
import { DemoSimulator } from "@mc/demo";
import { PROVIDERS, diffObservations } from "@mc/domain";
import { ApiError, type AuthUser, type ChangeTopic, type TavroApi } from "./api.js";

export interface DemoApiOptions {
  /** Simulation step in ms (default 4000). */
  tickMs?: number;
  /** Simulated connector outage cycle: online for this long, then offline (default 4 min / 2 min). */
  onlineMs?: number;
  offlineMs?: number;
  seed?: number;
  now?: () => number;
}

const DEMO_OWNER = "00000000-0000-4000-8000-000000000001";
const DEMO_HOST = "00000000-0000-4000-8000-0000000000a1";
const STALE_HOST = "00000000-0000-4000-8000-0000000000a2";

function uuidFrom(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Fully in-memory backend for demo mode. It runs the same diff logic the
 * connector uses, so status history and dedupe behave like the real thing.
 * All data is flagged is_demo and comes from the "mock" provider.
 */
export function createDemoApi(opts: DemoApiOptions = {}): TavroApi {
  const now = opts.now ?? (() => Date.now());
  const sim = new DemoSimulator({ seed: opts.seed ?? 42, now });
  const tickMs = opts.tickMs ?? 4000;
  const onlineMs = opts.onlineMs ?? 4 * 60_000;
  const offlineMs = opts.offlineMs ?? 2 * 60_000;
  const startedAt = now();
  const iso = (t: number) => new Date(t).toISOString();

  const user: AuthUser = { id: DEMO_OWNER, email: "demo@example.invalid" };
  let signedIn = true;
  let prefs: NotificationPrefs | null = null;
  let idCounter = 1000;

  const hosts = new Map<string, HostRow>([
    [
      DEMO_HOST,
      {
        id: DEMO_HOST,
        owner_id: DEMO_OWNER,
        name: "Demo laptop",
        platform: "simulated",
        connector_version: "demo",
        remote_control_allowed: false,
        last_seen_at: iso(startedAt),
        paired_at: iso(startedAt - 86_400_000),
        revoked_at: null,
        created_at: iso(startedAt - 86_400_000),
      },
    ],
    [
      STALE_HOST,
      {
        id: STALE_HOST,
        owner_id: DEMO_OWNER,
        name: "Demo desktop (switched off)",
        platform: "simulated",
        connector_version: "demo",
        remote_control_allowed: false,
        last_seen_at: iso(startedAt - 3 * 3_600_000),
        paired_at: iso(startedAt - 7 * 86_400_000),
        revoked_at: null,
        created_at: iso(startedAt - 7 * 86_400_000),
      },
    ],
  ]);

  const sessions = new Map<string, SessionRow>(); // by id
  const byExternal = new Map<string, string>(); // external_id -> id
  const events: SessionEventRow[] = [];
  const known = new Map<string, SessionStatus>();
  const listeners = new Set<(t: ChangeTopic) => void>();
  const emit = (t: ChangeTopic) => listeners.forEach((l) => l(t));
  const capabilities = [...PROVIDERS.mock.supported];

  // A session on the switched-off host, to demonstrate the "disconnected" state.
  const staleId = uuidFrom(++idCounter);
  sessions.set(staleId, {
    id: staleId,
    owner_id: DEMO_OWNER,
    host_id: STALE_HOST,
    provider: "mock",
    external_id: "demo-stale-1",
    title: "Nightly data import",
    project_label: "etl-jobs",
    status: "running",
    status_reason: "Simulated: last status before the host went offline.",
    status_source: "mock",
    last_activity_at: iso(startedAt - 3 * 3_600_000),
    last_event_summary: "Processing batch 14 of 40",
    capabilities,
    is_demo: true,
    started_at: iso(startedAt - 4 * 3_600_000),
    ended_at: null,
    updated_at: iso(startedAt - 3 * 3_600_000),
  });

  function hostOnline(t: number): boolean {
    return (t - startedAt) % (onlineMs + offlineMs) < onlineMs;
  }

  function sync(): void {
    const t = now();
    if (!hostOnline(t)) return; // connector "offline": no heartbeat, no updates
    const host = hosts.get(DEMO_HOST);
    if (!host || host.revoked_at) return;
    hosts.set(DEMO_HOST, { ...host, last_seen_at: iso(t) });
    emit("hosts");

    const observed = sim.observe();
    const transitions = diffObservations(known, observed, new Date(t));
    for (const o of observed) {
      let id = byExternal.get(o.external_id);
      if (!id) {
        id = uuidFrom(++idCounter);
        byExternal.set(o.external_id, id);
      }
      sessions.set(id, {
        id,
        owner_id: DEMO_OWNER,
        host_id: DEMO_HOST,
        provider: "mock",
        external_id: o.external_id,
        title: o.title,
        project_label: o.project_label,
        status: o.status,
        status_reason: o.status_reason,
        status_source: "mock",
        last_activity_at: o.last_activity_at,
        last_event_summary: o.last_event_summary,
        capabilities,
        is_demo: true,
        started_at: o.started_at,
        ended_at: null,
        updated_at: iso(t),
      });
      known.set(o.external_id, o.status);
    }
    for (const tr of transitions) {
      const id = byExternal.get(tr.external_id);
      const s = id ? sessions.get(id) : undefined;
      if (!id || !s) continue;
      if (tr.type === "session_ended") {
        sessions.set(id, { ...s, status: "ended", ended_at: iso(t), status_reason: "Simulated: the session process exited." });
        known.set(tr.external_id, "ended");
      }
      if (events.some((e) => e.session_id === id && e.dedupe_key === tr.dedupe_key)) continue;
      events.push({
        id: ++idCounter,
        owner_id: DEMO_OWNER,
        host_id: DEMO_HOST,
        session_id: id,
        type: tr.type,
        status: tr.status,
        summary: tr.type === "session_ended" ? "Session closed" : (sessions.get(id)?.last_event_summary ?? null),
        dedupe_key: tr.dedupe_key,
        is_demo: true,
        occurred_at: iso(t),
      });
    }
    if (events.length > 2000) events.splice(0, events.length - 2000);
    emit("sessions");
    if (transitions.length) emit("session_events");
  }

  sync();
  let timer: ReturnType<typeof setInterval> | null = null;
  const ensureTimer = () => {
    if (timer === null && tickMs > 0) {
      timer = setInterval(() => {
        sim.tick();
        sync();
      }, tickMs);
    }
  };

  const requireUser = () => {
    if (!signedIn) throw new ApiError("Please sign in.", "unauthorized");
    // Manual-clock mode (tests): advance on every read instead of a timer.
    if (tickMs === 0) sync();
  };

  return {
    kind: "demo",
    async getSchemaVersion() {
      return MAX_SCHEMA_VERSION;
    },
    async getUser() {
      return signedIn ? user : null;
    },
    async signIn() {
      signedIn = true;
    },
    async signOut() {
      signedIn = false;
    },
    onAuthChange() {
      return () => undefined;
    },
    async listSessions() {
      requireUser();
      return [...sessions.values()];
    },
    async getSession(id) {
      requireUser();
      return sessions.get(id) ?? null;
    },
    async listEvents(sessionId, limit = 100) {
      requireUser();
      return events
        .filter((e) => e.session_id === sessionId)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id - a.id)
        .slice(0, limit);
    },
    async listMessages(sessionId, limit = 50): Promise<SessionMessageRow[]> {
      requireUser();
      const s = sessions.get(sessionId);
      if (!s) return [];
      return sim
        .messages(s.external_id)
        .slice(-limit)
        .map((m, i) => ({ id: i + 1, session_id: sessionId, external_uuid: m.external_uuid, role: m.role, text: m.text, occurred_at: m.occurred_at }));
    },
    async listHosts() {
      requireUser();
      return [...hosts.values()];
    },
    async createHostPairing() {
      throw new ApiError("Pairing is not available in demo mode. Connect a Supabase project to pair a real host.", "invalid");
    },
    async revokeHost(hostId) {
      requireUser();
      const h = hosts.get(hostId);
      if (!h) throw new ApiError("Host not found.", "not_found");
      if (!h.revoked_at) hosts.set(hostId, { ...h, revoked_at: iso(now()) });
      emit("hosts");
    },
    async getNotificationPrefs() {
      requireUser();
      return prefs;
    },
    async saveNotificationPrefs(p) {
      requireUser();
      prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...p };
    },
    subscribe(cb) {
      listeners.add(cb);
      ensureTimer();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
