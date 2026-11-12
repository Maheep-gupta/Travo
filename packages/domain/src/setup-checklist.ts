// Guided setup checklist (spec 11.2, 11.3). Every step's state is derived from
// data the app already has: the chosen backend, the sign-in, the host list,
// the session list and this device's notification permission. Nothing is
// stored. A step is only "done" with evidence for it, and a list that is still
// loading or couldn't be loaded makes a step "unknown", never "not done".
// Pure: shared by the web app and the future Expo app.
import type { HostRow } from "@mc/contracts";
import type { SourceState } from "./data-availability.js";
import type { ClientSync } from "./freshness.js";
import { hostConnectivity, hostSourceOk } from "./hosts.js";
import { sourceFailureText } from "./source-failure.js";
import { relativeTime } from "./time.js";

export type SetupStepId = "backend" | "sign_in" | "pair_host" | "heartbeat" | "source" | "first_session" | "notifications";

/**
 * - done: there is evidence the step is complete;
 * - current: the first required step that isn't done, i.e. what to do next;
 * - blocked: not done, and waits on an earlier step;
 * - unknown: can't be judged right now (loading, failed to load, not current);
 * - optional: an optional step nobody has decided on (or can't be done here).
 */
export type SetupStepState = "done" | "current" | "blocked" | "unknown" | "optional";

/** Where a step's next action leads; each client maps these to its own screens. */
export type SetupAction =
  | { kind: "choose_backend" }
  | { kind: "sign_in" }
  | { kind: "hosts" }
  | { kind: "host"; hostId: string }
  | { kind: "sessions" }
  | { kind: "notifications" }
  /** Load the data the step is judged by again. */
  | { kind: "retry" };

export interface SetupStep {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
  /** Plain-language explanation of the state: the evidence, or what to do. */
  detail: string;
  action: SetupAction | null;
  actionLabel: string | null;
  optional: boolean;
  /** The evidence is simulated demo data, and must be labelled as such. */
  demo: boolean;
  /** For blocked steps: the step it waits on. */
  blockedBy: SetupStepId | null;
}

export interface SetupChecklist {
  steps: SetupStep[];
  /** Required steps done, out of `total` required steps. */
  done: number;
  total: number;
  /** Every required step is done. */
  complete: boolean;
  /** The step to do next; null when complete or when the next step can't be judged. */
  current: SetupStepId | null;
  demo: boolean;
}

export type SetupBackend = "none" | "demo" | "supabase";

/** This device's notification permission; the same states as the web app's system notifications. */
export type SetupNotifications = "unsupported" | "default" | "granted" | "denied";

export type SetupHostInput = Pick<HostRow, "id" | "name" | "last_seen_at" | "revoked_at" | "paired_at" | "provider_error_since" | "provider_error_kind">;

export interface SetupChecklistInput {
  backend: SetupBackend;
  signedIn: boolean;
  /** The host list: its query state, and its rows when any have loaded. */
  hosts: { state: SourceState; data: readonly SetupHostInput[] | null };
  /** The session list: rows shown, and rows that arrived but couldn't be read. */
  sessions: { state: SourceState; count: number | null; dropped: number };
  /** Whether the client is keeping its copy current; present-tense steps need "current". */
  sync: ClientSync;
  notifications: SetupNotifications;
  now: Date;
}

const TITLES: Record<SetupStepId, string> = {
  backend: "Choose where your data lives",
  sign_in: "Sign in",
  pair_host: "Pair a host",
  heartbeat: "Connector reporting",
  source: "Session source answering",
  first_session: "First session seen",
  notifications: "Decide on notifications",
};

/** What each step is, shown while it waits on an earlier one. */
const ABOUT: Record<SetupStepId, string> = {
  backend: "Demo data, or a Supabase project you own.",
  sign_in: "Sign in to the backend you chose.",
  pair_host: "Pair the laptop where your AI sessions run, using a single-use code.",
  heartbeat: "The connector on that laptop checks in every 30 seconds.",
  source: "The connector can read the sessions on its laptop.",
  first_session: "A session reported by your connector shows up in Tavro.",
  notifications: "Choose which alerts you want, and whether this device shows system notifications.",
};

const REQUIRED: readonly SetupStepId[] = ["backend", "sign_in", "pair_host", "heartbeat", "source", "first_session"];

/** A step judged on its own, before ordering decides current and blocked. */
interface Evaluation {
  outcome: "done" | "todo" | "unknown";
  detail: string;
  action?: SetupAction;
  actionLabel?: string;
  demo?: boolean;
}

const RETRY = { action: { kind: "retry" } as const, actionLabel: "Try again" };

const NOT_CURRENT: Record<Exclude<ClientSync, "current">, string> = {
  offline: "you're offline",
  unreachable: "your project can't be reached",
  stale: "the latest refresh failed",
};

function listNames(hosts: readonly SetupHostInput[]): string {
  const names = hosts.map((h) => h.name);
  return names.length <= 2 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

function backendStep(i: SetupChecklistInput): Evaluation {
  if (i.backend === "none") {
    return { outcome: "todo", detail: "Explore with demo data, or connect a Supabase project you own. Tavro has no servers of its own.", action: { kind: "choose_backend" }, actionLabel: "Choose a backend" };
  }
  if (i.backend === "demo") {
    return {
      outcome: "done",
      detail: "Using demo data: simulated sessions generated in this browser. To see your own sessions, connect your Supabase project from Settings.",
      action: { kind: "choose_backend" },
      actionLabel: "Connect your own project",
      demo: true,
    };
  }
  return { outcome: "done", detail: "Connected to your Supabase project." };
}

function signInStep(i: SetupChecklistInput): Evaluation {
  if (i.signedIn) return { outcome: "done", detail: i.backend === "demo" ? "Signed in to the demo account." : "Signed in to your project.", demo: i.backend === "demo" };
  return { outcome: "todo", detail: "Sign in to the backend you chose.", action: { kind: "sign_in" }, actionLabel: "Sign in" };
}

/** Hosts not revoked whose connector has exchanged its code (or has ever heartbeated). */
function pairedHosts(hosts: readonly SetupHostInput[]): SetupHostInput[] {
  return hosts.filter((h) => !h.revoked_at && (h.paired_at !== null || h.last_seen_at !== null));
}

function hostsUnknown(i: SetupChecklistInput): Evaluation | null {
  if (i.hosts.state === "loading") return { outcome: "unknown", detail: "Checking your hosts…" };
  if (!i.hosts.data) return { outcome: "unknown", detail: "Your hosts couldn't be loaded, so this can't be checked.", ...RETRY };
  return null;
}

function pairStep(i: SetupChecklistInput): Evaluation {
  const unknown = hostsUnknown(i);
  if (unknown) return unknown;
  const hosts = i.hosts.data ?? [];
  const demo = i.backend === "demo";
  const paired = pairedHosts(hosts);
  if (paired.length) {
    const detail = demo
      ? `Simulated demo ${paired.length === 1 ? "host" : "hosts"}: ${listNames(paired)}. Pairing a real laptop needs your own project.`
      : `${listNames(paired)} ${paired.length === 1 ? "is" : "are"} paired.`;
    return { outcome: "done", detail, action: { kind: "hosts" }, actionLabel: "View hosts", demo };
  }
  const action = { action: { kind: "hosts" } as const, actionLabel: "Pair a host" };
  if (demo) return { outcome: "todo", detail: "The demo has no simulated hosts right now. Pairing a real laptop needs your own project.", demo };
  if (hosts.some((h) => !h.revoked_at)) {
    return { outcome: "todo", detail: "A pairing code was created, but no connector has used it yet. Codes expire after 10 minutes; create a new one if it has.", ...action };
  }
  if (hosts.length) return { outcome: "todo", detail: "Every host you paired has been revoked. Pair one again to see its sessions.", ...action };
  return { outcome: "todo", detail: "Pair the laptop where your AI sessions run. Tavro gives you a single-use code for its connector.", ...action };
}

/** Present-tense steps can only be confirmed from a current copy of the host list. */
function liveUnknown(i: SetupChecklistInput): Evaluation | null {
  const unknown = hostsUnknown(i);
  if (unknown) return unknown;
  if (i.sync !== "current") return { outcome: "unknown", detail: `Can't confirm right now: ${NOT_CURRENT[i.sync]}.`, ...RETRY };
  return null;
}

function onlineHosts(i: SetupChecklistInput): SetupHostInput[] {
  return pairedHosts(i.hosts.data ?? []).filter((h) => hostConnectivity(h, i.now) === "online");
}

function heartbeatStep(i: SetupChecklistInput): Evaluation {
  const demo = i.backend === "demo";
  const paired = pairedHosts(i.hosts.data ?? []);
  if (i.hosts.data && !paired.length) return { outcome: "todo", detail: "Needs a paired host first.", demo };
  const unknown = liveUnknown(i);
  if (unknown) return unknown;
  const online = onlineHosts(i);
  if (online.length) {
    return { outcome: "done", detail: `${listNames(online)} ${online.length === 1 ? "is" : "are"} reporting.`, demo };
  }
  // The most recently seen host is the one most likely to come back.
  const seen = paired.filter((h) => h.last_seen_at !== null).sort((a, b) => Date.parse(b.last_seen_at ?? "") - Date.parse(a.last_seen_at ?? ""));
  const latest = seen[0];
  if (!latest) {
    const first = paired[0];
    return {
      outcome: "todo",
      detail: `${listNames(paired)} ${paired.length === 1 ? "was" : "were"} paired, but no connector has checked in yet. Start it on the laptop with npm run connector -- run.`,
      ...(first ? { action: { kind: "host", hostId: first.id } as const, actionLabel: `View ${first.name}` } : {}),
      demo,
    };
  }
  return {
    outcome: "todo",
    detail: `No connector is reporting. ${latest.name} last checked in ${relativeTime(latest.last_seen_at, i.now)}; check that its connector is still running and online.`,
    action: { kind: "host", hostId: latest.id },
    actionLabel: `View ${latest.name}`,
    demo,
  };
}

/**
 * The host pages' wording (sourceFailureText), so the two can't drift. The
 * start time belongs to the failure, not its category: a category can change
 * while it lasts, so "since" is kept off the category's sentence.
 */
function sourceProblem(h: SetupHostInput, now: Date): string {
  const failure = sourceFailureText(h.provider_error_kind);
  return `${h.name}'s connector is running, but has had a problem since ${relativeTime(h.provider_error_since, now)}. ${failure.summary}: ${failure.title}.`;
}

function sourceStep(i: SetupChecklistInput): Evaluation {
  const demo = i.backend === "demo";
  if (i.hosts.data && !pairedHosts(i.hosts.data).length) return { outcome: "todo", detail: "Needs a paired host first.", demo };
  const unknown = liveUnknown(i);
  if (unknown) return unknown;
  const online = onlineHosts(i);
  const [failing] = online;
  if (!failing) return { outcome: "todo", detail: "Needs a connector that is reporting.", demo };
  const healthy = online.filter(hostSourceOk);
  if (healthy.length) return { outcome: "done", detail: `${listNames(healthy)} can read ${healthy.length === 1 ? "its" : "their"} sessions.`, demo };
  return {
    outcome: "todo",
    detail: `${sourceProblem(failing, i.now)} Its sessions' status may be out of date until it recovers.`,
    action: { kind: "host", hostId: failing.id },
    actionLabel: `View ${failing.name}`,
    demo,
  };
}

function firstSessionStep(i: SetupChecklistInput): Evaluation {
  const demo = i.backend === "demo";
  const { state, count, dropped } = i.sessions;
  if (state === "loading") return { outcome: "unknown", detail: "Checking for sessions…" };
  if (count === null) return { outcome: "unknown", detail: "Your sessions couldn't be loaded, so this can't be checked.", ...RETRY };
  if (count > 0) {
    return {
      outcome: "done",
      detail: demo ? "Simulated demo sessions are showing." : "Tavro has received sessions from your connector.",
      action: { kind: "sessions" },
      actionLabel: "View sessions",
      demo,
    };
  }
  if (dropped > 0) {
    return {
      outcome: "todo",
      detail: `${dropped === 1 ? "A session" : `${dropped} sessions`} arrived but couldn't be read, so nothing is shown yet.`,
      action: { kind: "sessions" },
      actionLabel: "Open sessions",
      demo,
    };
  }
  return {
    outcome: "todo",
    detail: "No sessions yet. They appear once a paired connector reports one. Claude Code support isn't enabled in this release.",
    action: { kind: "sessions" },
    actionLabel: "Open sessions",
    demo,
  };
}

function notificationsStep(i: SetupChecklistInput): Evaluation {
  const action = i.signedIn ? { action: { kind: "notifications" } as const, actionLabel: "Alert settings" } : {};
  if (i.notifications === "granted") {
    return { outcome: "done", detail: "System notifications are allowed on this device. They only arrive while Tavro is open.", ...action };
  }
  // Blocked is a choice, not a finished step: it stays optional, never shown done.
  if (i.notifications === "denied") {
    return { outcome: "todo", detail: "You blocked notifications for this site. In-app alerts still work; allow them in your browser's site settings to change this.", ...action };
  }
  if (i.notifications === "unsupported") {
    return { outcome: "todo", detail: "This browser can't show system notifications here. In-app alerts still work.", ...action };
  }
  return { outcome: "todo", detail: "Optional. Choose which alerts you want, and whether this device shows system notifications while Tavro is open.", ...action };
}

const EVALUATE: Record<SetupStepId, (i: SetupChecklistInput) => Evaluation> = {
  backend: backendStep,
  sign_in: signInStep,
  pair_host: pairStep,
  heartbeat: heartbeatStep,
  source: sourceStep,
  first_session: firstSessionStep,
  notifications: notificationsStep,
};

function step(id: SetupStepId, e: Evaluation, state: SetupStepState, blockedBy: SetupStepId | null): SetupStep {
  const blocked = state === "blocked";
  return {
    id,
    title: TITLES[id],
    state,
    detail: blocked && blockedBy ? `${ABOUT[id]} Waits on “${TITLES[blockedBy]}”.` : e.detail,
    action: blocked ? null : (e.action ?? null),
    actionLabel: blocked ? null : (e.actionLabel ?? null),
    optional: id === "notifications",
    demo: e.demo ?? false,
    blockedBy: blocked ? blockedBy : null,
  };
}

/**
 * The checklist. Required steps run in order: the first one not done is the
 * gate. Before it everything is done; the gate is "current" (or "unknown" if
 * it can't be judged); after it, a step with its own evidence is still shown
 * done or unknown, and anything else is blocked on the gate. Spec 11.3: setup
 * is never shown complete while any required step lacks evidence.
 */
export function setupChecklist(input: SetupChecklistInput): SetupChecklist {
  // Before a backend and a sign-in there are no hosts or sessions to look at:
  // those steps wait, rather than read as "checking".
  const reachable = input.backend !== "none" && input.signedIn;
  const evaluate = (id: SetupStepId): Evaluation =>
    reachable || id === "backend" || id === "sign_in" ? EVALUATE[id](input) : { outcome: "todo", detail: ABOUT[id] };
  const evaluations = REQUIRED.map((id) => ({ id, e: evaluate(id) }));
  const gateIndex = evaluations.findIndex(({ e }) => e.outcome !== "done");
  const gate = gateIndex === -1 ? null : (evaluations[gateIndex] ?? null);
  const steps = evaluations.map(({ id, e }, index) => {
    if (e.outcome === "done") return step(id, e, "done", null);
    if (e.outcome === "unknown") return step(id, e, "unknown", null);
    return index === gateIndex ? step(id, e, "current", null) : step(id, e, "blocked", gate?.id ?? null);
  });
  const notifications = notificationsStep(input);
  steps.push(step("notifications", notifications, notifications.outcome === "done" ? "done" : "optional", null));
  const done = evaluations.filter(({ e }) => e.outcome === "done").length;
  return {
    steps,
    done,
    total: REQUIRED.length,
    complete: done === REQUIRED.length,
    current: gate && gate.e.outcome === "todo" ? gate.id : null,
    demo: input.backend === "demo",
  };
}

/** One-line progress, e.g. for the checklist's heading. Says DEMO when the evidence is simulated. */
export function setupSummary(c: SetupChecklist): string {
  if (c.complete) return c.demo ? "Demo setup complete: everything shown is simulated." : "Setup complete.";
  return `${c.done} of ${c.total} steps done${c.demo ? " (demo data)" : ""}.`;
}

/** Plain status text for a step, so its state is never conveyed by colour or icon alone. */
export const SETUP_STATE_LABEL: Record<SetupStepState, string> = {
  done: "Done",
  current: "Next step",
  blocked: "Waiting",
  unknown: "Can't tell yet",
  optional: "Optional",
};
