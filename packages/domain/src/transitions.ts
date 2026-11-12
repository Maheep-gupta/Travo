import type { SessionStatus } from "@mc/contracts";

/**
 * The session transition model (spec 4.2). Pure, so the connector's event log,
 * the in-memory demo and the alert engine apply the same rules.
 *
 * Rules, and how this module answers them:
 * - Out-of-order and delayed observations: one older than the recorded one is
 *   ignored. An equal time is applied, as the database's stale-write guard
 *   does (schema v3), so an identical retry is a harmless no-op.
 * - Duplicates: the same status again is "unchanged", never a transition.
 * - Missing data is not negative evidence: an unreadable source is no
 *   observation at all, and an "unknown" status only loses evidence. The last
 *   known status is kept, so X → unknown → X is not a new transition.
 * - Absence from a complete, successful read is negative evidence that the
 *   session is no longer listed: it becomes "ended", never "completed".
 * - Needs approval → anything else only on a read that isn't older than the
 *   one that reported the approval. Statuses carried forward while a host or
 *   its source can't be trusted are not reads, so they never resolve it.
 * - Completed or failed → an active state is a restart: only the source can
 *   report a finished session as live again, and a session id is its lifecycle.
 *
 * No status pair is forbidden outright: sources are polled, so intermediate
 * states can be missed (waiting → approval without the working in between),
 * and refusing what the source reports would show a stale state as current.
 * What is refused is weaker evidence overriding stronger evidence.
 */

/** Every SessionStatus; the Record type makes the compiler insist on all of them. */
const STATE_SET: Record<SessionStatus, true> = {
  running: true,
  waiting_for_input: true,
  approval_required: true,
  completed: true,
  failed: true,
  ended: true,
  unknown: true,
};
export const SESSION_STATES: readonly SessionStatus[] = Object.keys(STATE_SET) as SessionStatus[];

/** What kind of change an edge between two different statuses is. */
export type TransitionEdge =
  /** Between active states: working ↔ waiting, → needs approval. */
  | "progressed"
  /** Needs approval → any other state, on a genuine read. */
  | "approval_resolved"
  /** → completed or failed. */
  | "finished"
  /** Completed or failed → an active state: the source reports it live again. */
  | "restarted"
  /** → ended: no longer listed by the source. */
  | "ended"
  /** Ended → listed again: the earlier absence was not the end after all. */
  | "reappeared"
  /** → unknown: the source answered but couldn't say. */
  | "evidence_lost"
  /** Unknown → the first recognisable status. */
  | "identified";

const FINISHED: ReadonlySet<SessionStatus> = new Set(["completed", "failed"]);

/** Classifies an edge; null when the statuses are equal (no edge at all). */
export function classifyEdge(from: SessionStatus, to: SessionStatus): TransitionEdge | null {
  if (from === to) return null;
  if (to === "unknown") return "evidence_lost";
  if (to === "ended") return "ended";
  if (from === "unknown") return "identified";
  if (from === "ended") return "reappeared";
  if (from === "approval_required") return "approval_resolved";
  if (FINISHED.has(to)) return "finished";
  if (FINISHED.has(from)) return "restarted";
  return "progressed";
}

/** What is remembered about a session between observations. */
export interface TransitionRecord {
  /** Last accepted status, "unknown" included. */
  status: SessionStatus;
  /** Last status other than "unknown"; "unknown" only if none was ever known. */
  known: SessionStatus;
  /** ISO time of the newest accepted observation; null if not known (e.g. after a restart). */
  observedAt: string | null;
}

export type SessionObservation =
  /** A successful read listed the session with this status. */
  | { kind: "listed"; status: SessionStatus; observedAt: string | null }
  /** A complete, successful read did not list the session. */
  | { kind: "absent"; observedAt: string | null }
  /** The read failed or was partial: nothing is known about the session. */
  | { kind: "unreadable"; observedAt: string | null };

export type TransitionDecision =
  /** A genuine state change: record an event; it may raise an alert. */
  | { outcome: "transition"; edge: TransitionEdge | "discovered"; from: SessionStatus | null; to: SessionStatus; at: string | null; record: TransitionRecord }
  /** The stored status changes, the known state doesn't: never an alert. */
  | { outcome: "evidence"; reason: "evidence_lost" | "evidence_regained"; to: SessionStatus; at: string | null; record: TransitionRecord }
  /** Same status again (a duplicate or a refresh): apply the newer values, no event. */
  | { outcome: "unchanged"; record: TransitionRecord }
  /** Apply nothing; the record stays as it was. */
  | { outcome: "ignored"; reason: "out_of_order" | "no_evidence" | "not_known"; record: TransitionRecord | null };

/** A record for a status seen for the first time. */
export function initialRecord(status: SessionStatus, observedAt: string | null): TransitionRecord {
  return { status, known: status, observedAt };
}

function time(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** True when both times are known and `observed` is strictly older than `recorded`. */
export function isOutOfOrder(recorded: string | null, observed: string | null): boolean {
  const r = time(recorded);
  const o = time(observed);
  return r !== null && o !== null && o < r;
}

/**
 * Decides what a new observation means for a session, given what was last
 * accepted (null if the session was never seen). Never throws.
 */
export function decideTransition(previous: TransitionRecord | null, observation: SessionObservation): TransitionDecision {
  if (observation.kind === "unreadable") return { outcome: "ignored", reason: "no_evidence", record: previous };
  const at = observation.observedAt;
  if (previous === null) {
    if (observation.kind === "absent") return { outcome: "ignored", reason: "not_known", record: null };
    return { outcome: "transition", edge: "discovered", from: null, to: observation.status, at, record: initialRecord(observation.status, at) };
  }
  if (isOutOfOrder(previous.observedAt, at)) return { outcome: "ignored", reason: "out_of_order", record: previous };

  const to: SessionStatus = observation.kind === "absent" ? "ended" : observation.status;
  const observedAt = time(at) === null ? previous.observedAt : at;
  if (to === previous.status) return { outcome: "unchanged", record: { ...previous, observedAt } };
  if (to === "unknown") {
    return { outcome: "evidence", reason: "evidence_lost", to, at, record: { status: "unknown", known: previous.known, observedAt } };
  }
  const record = initialRecord(to, observedAt);
  // Back to what was known before the source lost track: not a new state.
  if (to === previous.known) return { outcome: "evidence", reason: "evidence_regained", to, at, record };
  // previous.known !== to here, so the edge exists.
  const edge = classifyEdge(previous.known, to) ?? "progressed";
  return { outcome: "transition", edge, from: previous.known, to, at, record };
}
