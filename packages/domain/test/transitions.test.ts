import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@mc/contracts";
import {
  SESSION_STATES,
  classifyEdge,
  decideTransition,
  diffObservations,
  initialRecord,
  isOutOfOrder,
  type TransitionEdge,
  type TransitionRecord,
} from "../src/index.js";

const T0 = "2026-11-12T10:00:00.000Z";
const T1 = "2026-11-12T10:00:05.000Z";
const TM = "2026-11-12T09:59:55.000Z"; // older than T0

/** The expected edge for every ordered pair of different statuses (7 × 6 = 42). */
const EDGES: Record<SessionStatus, Partial<Record<SessionStatus, TransitionEdge>>> = {
  running: { waiting_for_input: "progressed", approval_required: "progressed", completed: "finished", failed: "finished", ended: "ended", unknown: "evidence_lost" },
  waiting_for_input: { running: "progressed", approval_required: "progressed", completed: "finished", failed: "finished", ended: "ended", unknown: "evidence_lost" },
  approval_required: { running: "approval_resolved", waiting_for_input: "approval_resolved", completed: "approval_resolved", failed: "approval_resolved", ended: "ended", unknown: "evidence_lost" },
  completed: { running: "restarted", waiting_for_input: "restarted", approval_required: "restarted", failed: "finished", ended: "ended", unknown: "evidence_lost" },
  failed: { running: "restarted", waiting_for_input: "restarted", approval_required: "restarted", completed: "finished", ended: "ended", unknown: "evidence_lost" },
  ended: { running: "reappeared", waiting_for_input: "reappeared", approval_required: "reappeared", completed: "reappeared", failed: "reappeared", unknown: "evidence_lost" },
  unknown: { running: "identified", waiting_for_input: "identified", approval_required: "identified", completed: "identified", failed: "identified", ended: "ended" },
};

const PAIRS: [SessionStatus, SessionStatus][] = SESSION_STATES.flatMap((from) => SESSION_STATES.map((to): [SessionStatus, SessionStatus] => [from, to]));

describe("SESSION_STATES", () => {
  it("lists every session status once", () => {
    expect([...SESSION_STATES].sort()).toEqual(["approval_required", "completed", "ended", "failed", "running", "unknown", "waiting_for_input"]);
  });
});

describe("classifyEdge", () => {
  it.each(PAIRS)("%s → %s", (from, to) => {
    expect(classifyEdge(from, to)).toBe(from === to ? null : EDGES[from][to]);
  });

  it("covers the spec 4.2 edges", () => {
    expect(classifyEdge("running", "waiting_for_input")).toBe("progressed");
    expect(classifyEdge("running", "approval_required")).toBe("progressed");
    expect(classifyEdge("running", "completed")).toBe("finished");
    expect(classifyEdge("waiting_for_input", "running")).toBe("progressed");
    expect(classifyEdge("approval_required", "running")).toBe("approval_resolved");
    expect(classifyEdge("completed", "running")).toBe("restarted");
  });
});

describe("decideTransition: a newer read listing the session", () => {
  it.each(PAIRS)("%s → %s", (from, to) => {
    const d = decideTransition(initialRecord(from, T0), { kind: "listed", status: to, observedAt: T1 });
    if (from === to) {
      // Duplicates and refreshes are never transitions; the newer time is kept.
      expect(d).toEqual({ outcome: "unchanged", record: { status: from, known: from, observedAt: T1 } });
    } else if (to === "unknown") {
      // Missing data: the stored status changes, the known one doesn't.
      expect(d).toEqual({ outcome: "evidence", reason: "evidence_lost", to, at: T1, record: { status: "unknown", known: from, observedAt: T1 } });
    } else {
      expect(d).toEqual({ outcome: "transition", edge: EDGES[from][to], from, to, at: T1, record: { status: to, known: to, observedAt: T1 } });
    }
  });
});

describe("decideTransition: an older read (delayed or out of order)", () => {
  it.each(PAIRS)("%s → %s is ignored and the record kept", (from, to) => {
    const before = initialRecord(from, T0);
    expect(decideTransition(before, { kind: "listed", status: to, observedAt: TM })).toEqual({ outcome: "ignored", reason: "out_of_order", record: before });
    expect(decideTransition(before, { kind: "absent", observedAt: TM })).toEqual({ outcome: "ignored", reason: "out_of_order", record: before });
  });
});

describe("decideTransition: a read at the same time (a retry)", () => {
  it.each(PAIRS)("%s → %s is applied like the database does", (from, to) => {
    const d = decideTransition(initialRecord(from, T0), { kind: "listed", status: to, observedAt: T0 });
    expect(d.outcome).toBe(from === to ? "unchanged" : to === "unknown" ? "evidence" : "transition");
  });
});

describe("decideTransition: missing data versus negative evidence", () => {
  it.each(SESSION_STATES)("an unreadable source says nothing about a %s session", (from) => {
    const before = initialRecord(from, T0);
    expect(decideTransition(before, { kind: "unreadable", observedAt: T1 })).toEqual({ outcome: "ignored", reason: "no_evidence", record: before });
  });

  it.each(SESSION_STATES)("absence from a complete read ends a %s session (never completes it)", (from) => {
    const d = decideTransition(initialRecord(from, T0), { kind: "absent", observedAt: T1 });
    if (from === "ended") expect(d).toEqual({ outcome: "unchanged", record: { status: "ended", known: "ended", observedAt: T1 } });
    else expect(d).toEqual({ outcome: "transition", edge: "ended", from, to: "ended", at: T1, record: { status: "ended", known: "ended", observedAt: T1 } });
  });

  it("ignores the absence of a session it never saw, and an unreadable source for one", () => {
    expect(decideTransition(null, { kind: "absent", observedAt: T1 })).toEqual({ outcome: "ignored", reason: "not_known", record: null });
    expect(decideTransition(null, { kind: "unreadable", observedAt: T1 })).toEqual({ outcome: "ignored", reason: "no_evidence", record: null });
  });

  it.each(SESSION_STATES)("discovers a session first listed as %s", (status) => {
    expect(decideTransition(null, { kind: "listed", status, observedAt: T1 })).toEqual({
      outcome: "transition",
      edge: "discovered",
      from: null,
      to: status,
      at: T1,
      record: { status, known: status, observedAt: T1 },
    });
  });
});

describe("decideTransition: across an unknown status", () => {
  const lost = (known: SessionStatus): TransitionRecord => ({ status: "unknown", known, observedAt: T0 });

  it.each(SESSION_STATES.filter((s) => s !== "unknown"))("%s → unknown → the same status is regained evidence, not a transition", (known) => {
    expect(decideTransition(lost(known), { kind: "listed", status: known, observedAt: T1 })).toEqual({
      outcome: "evidence",
      reason: "evidence_regained",
      to: known,
      at: T1,
      record: { status: known, known, observedAt: T1 },
    });
  });

  it.each(PAIRS.filter(([from, to]) => from !== "unknown" && to !== "unknown" && from !== to))("%s → unknown → %s is a transition from the known status", (known, to) => {
    expect(decideTransition(lost(known), { kind: "listed", status: to, observedAt: T1 })).toMatchObject({ outcome: "transition", edge: EDGES[known][to], from: known, to });
  });

  it("keeps the known status while unknown repeats, and ends from it", () => {
    expect(decideTransition(lost("approval_required"), { kind: "listed", status: "unknown", observedAt: T1 })).toEqual({
      outcome: "unchanged",
      record: { status: "unknown", known: "approval_required", observedAt: T1 },
    });
    expect(decideTransition(lost("approval_required"), { kind: "absent", observedAt: T1 })).toMatchObject({ outcome: "transition", edge: "ended", from: "approval_required" });
    // Never known at all: the first real status is identified.
    expect(decideTransition(initialRecord("unknown", T0), { kind: "listed", status: "failed", observedAt: T1 })).toMatchObject({ outcome: "transition", edge: "identified", from: "unknown" });
  });
});

describe("decideTransition: times", () => {
  it("can't order without both times (after a restart), so it applies the read", () => {
    expect(decideTransition(initialRecord("running", null), { kind: "listed", status: "completed", observedAt: TM }).outcome).toBe("transition");
    expect(decideTransition(initialRecord("running", T0), { kind: "listed", status: "completed", observedAt: null })).toMatchObject({
      outcome: "transition",
      record: { observedAt: T0 },
    });
    expect(decideTransition(initialRecord("running", "garbage"), { kind: "listed", status: "completed", observedAt: TM }).outcome).toBe("transition");
  });

  it("never moves the recorded time backwards", () => {
    const d = decideTransition(initialRecord("running", T0), { kind: "listed", status: "running", observedAt: "not a time" });
    expect(d).toEqual({ outcome: "unchanged", record: { status: "running", known: "running", observedAt: T0 } });
  });

  it("isOutOfOrder needs two valid times and a strictly older observation", () => {
    expect(isOutOfOrder(T0, TM)).toBe(true);
    expect(isOutOfOrder(T0, T0)).toBe(false);
    expect(isOutOfOrder(T0, T1)).toBe(false);
    expect(isOutOfOrder(null, TM)).toBe(false);
    expect(isOutOfOrder(T0, null)).toBe(false);
    expect(isOutOfOrder("x", TM)).toBe(false);
  });
});

describe("diffObservations follows the model", () => {
  const now = new Date(T1);
  it.each(PAIRS)("%s → %s", (from, to) => {
    const events = diffObservations(new Map([["a", from]]), [{ external_id: "a", status: to }], now);
    expect(events).toEqual(from === to ? [] : [{ external_id: "a", type: "status_changed", status: to, dedupe_key: `status:${to}:${T1}` }]);
  });

  it.each(SESSION_STATES)("a %s session missing from the read is ended once", (from) => {
    const events = diffObservations(new Map([["a", from]]), [], now);
    expect(events).toEqual(from === "ended" ? [] : [{ external_id: "a", type: "session_ended", status: "ended", dedupe_key: `ended:${T1}` }]);
  });
});
