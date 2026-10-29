/**
 * Deterministic simulator of Claude-like sessions for demos and tests.
 * Everything it produces is fake and must be flagged is_demo / "mock".
 * Platform-neutral: used by the connector's mock provider (Node) and by the
 * web app's demo mode (browser), and usable from React Native later.
 */
import type { SessionStatus } from "@mc/contracts";

export interface DemoObservation {
  external_id: string;
  title: string;
  project_label: string;
  status: SessionStatus;
  status_reason: string;
  last_activity_at: string;
  last_event_summary: string;
  started_at: string;
}

export interface DemoMessage {
  external_uuid: string;
  role: "user" | "assistant";
  text: string;
  occurred_at: string;
}

interface SimSession {
  external_id: string;
  title: string;
  project_label: string;
  status: SessionStatus;
  summary: string;
  last_activity: number;
  started: number;
  messages: DemoMessage[];
}

/** Small seeded PRNG (mulberry32) so tests and demos are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRANSITIONS: Partial<Record<SessionStatus, [SessionStatus, number][]>> = {
  running: [
    ["waiting_for_input", 0.14],
    ["approval_required", 0.07],
    ["completed", 0.05],
    ["failed", 0.03],
  ],
  waiting_for_input: [["running", 0.2], ["ended", 0.02]],
  approval_required: [["running", 0.18]],
  completed: [["running", 0.06], ["ended", 0.04]],
  failed: [["running", 0.08], ["ended", 0.04]],
};

const SUMMARIES: Record<SessionStatus, string[]> = {
  running: ["Editing src/billing/invoice.ts", "Running the test suite", "Searching the codebase for usages", "Reading migration files"],
  waiting_for_input: ["Asked which approach to take for the cache layer", "Finished the turn and is waiting for your reply"],
  approval_required: ["Wants to run: npm run build", "Wants to edit 3 files in packages/api"],
  completed: ["Reported: all 128 tests passing", "Reported: refactor complete, summary written"],
  failed: ["API error: overloaded (simulated)", "Build failed: 2 type errors (simulated)"],
  ended: ["Session closed"],
  unknown: ["Status could not be determined"],
};

const REASONS: Record<SessionStatus, string> = {
  running: "Simulated: the session is working.",
  waiting_for_input: "Simulated: the session is idle at its prompt.",
  approval_required: "Simulated: a permission prompt is open.",
  completed: "Simulated: the session reported completion.",
  failed: "Simulated: the session reported an error.",
  ended: "Simulated: the session process exited.",
  unknown: "Simulated: no status information.",
};

const SEED_SESSIONS: { title: string; project: string; status: SessionStatus }[] = [
  { title: "Refactor auth middleware", project: "payments-api", status: "approval_required" },
  { title: "Fix flaky checkout e2e test", project: "storefront", status: "running" },
  { title: "Write migration for invoices", project: "payments-api", status: "waiting_for_input" },
  { title: "Upgrade React Router", project: "admin-portal", status: "completed" },
  { title: "Investigate memory leak", project: "worker-service", status: "failed" },
  { title: "Draft release notes", project: "docs-site", status: "running" },
];

export interface DemoSimulatorOptions {
  seed?: number;
  now?: () => number;
}

export class DemoSimulator {
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly sessions: SimSession[];
  private counter = 0;

  constructor(opts: DemoSimulatorOptions = {}) {
    this.random = seededRandom(opts.seed ?? 42);
    this.now = opts.now ?? (() => Date.now());
    const t = this.now();
    this.sessions = SEED_SESSIONS.map((s, i) => {
      const started = t - (i + 1) * 17 * 60_000;
      const sim: SimSession = {
        external_id: `demo-${i + 1}`,
        title: s.title,
        project_label: s.project,
        status: s.status,
        summary: this.pick(SUMMARIES[s.status]),
        last_activity: t - i * 3 * 60_000,
        started,
        messages: [],
      };
      this.addMessage(sim, "user", `(demo) ${s.title}. Please take a look.`, started);
      this.addMessage(sim, "assistant", `(demo) ${sim.summary}.`, sim.last_activity);
      return sim;
    });
  }

  private pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.random() * items.length)];
    if (item === undefined) throw new Error("empty list");
    return item;
  }

  private addMessage(s: SimSession, role: "user" | "assistant", text: string, at: number): void {
    this.counter += 1;
    s.messages.push({ external_uuid: `${s.external_id}-m${this.counter}`, role, text, occurred_at: new Date(at).toISOString() });
    if (s.messages.length > 20) s.messages.shift();
  }

  /** Advance the simulation by one step. */
  tick(): void {
    const t = this.now();
    for (const s of this.sessions) {
      if (s.status === "ended") continue;
      const options = TRANSITIONS[s.status] ?? [];
      let roll = this.random();
      for (const [next, p] of options) {
        if (roll < p) {
          s.status = next;
          s.summary = this.pick(SUMMARIES[next]);
          s.last_activity = t;
          this.addMessage(s, next === "running" ? "user" : "assistant", `(demo) ${s.summary}.`, t);
          break;
        }
        roll -= p;
      }
    }
    // Keep the demo populated: replace ended sessions occasionally.
    const ended = this.sessions.findIndex((s) => s.status === "ended");
    if (ended >= 0 && this.random() < 0.1) {
      const seed = this.pick(SEED_SESSIONS);
      this.counter += 1;
      this.sessions.splice(ended, 1, {
        external_id: `demo-${this.counter}-${Math.floor(this.random() * 1e6)}`,
        title: seed.title,
        project_label: seed.project,
        status: "running",
        summary: this.pick(SUMMARIES.running),
        last_activity: t,
        started: t,
        messages: [],
      });
    }
  }

  /** Sessions currently "visible" (ended ones disappear, like a closed process). */
  observe(): DemoObservation[] {
    return this.sessions
      .filter((s) => s.status !== "ended")
      .map((s) => ({
        external_id: s.external_id,
        title: s.title,
        project_label: s.project_label,
        status: s.status,
        status_reason: REASONS[s.status],
        last_activity_at: new Date(s.last_activity).toISOString(),
        last_event_summary: s.summary,
        started_at: new Date(s.started).toISOString(),
      }));
  }

  messages(externalId: string): DemoMessage[] {
    return [...(this.sessions.find((s) => s.external_id === externalId)?.messages ?? [])];
  }
}
