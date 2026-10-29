import type { SessionStatus } from "@mc/contracts";

/**
 * What the UI shows. "disconnected" is never stored on a session: it is
 * derived when the session's host has stopped heartbeating, because in that
 * case the last stored status can no longer be trusted.
 */
export type DisplayStatus = SessionStatus | "disconnected";

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  running: "Working",
  waiting_for_input: "Waiting for you",
  approval_required: "Needs approval",
  completed: "Completed",
  failed: "Failed",
  ended: "Ended",
  disconnected: "Disconnected",
  unknown: "Unknown",
};

/** Lower rank = needs attention sooner. */
const ATTENTION_RANK: Record<DisplayStatus, number> = {
  approval_required: 0,
  waiting_for_input: 1,
  failed: 2,
  disconnected: 3,
  completed: 4,
  running: 5,
  unknown: 6,
  ended: 7,
};

export function attentionRank(status: DisplayStatus): number {
  return ATTENTION_RANK[status];
}

export function needsAttention(status: DisplayStatus): boolean {
  return status === "approval_required" || status === "waiting_for_input" || status === "failed";
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set(["ended"]);

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}

export interface MappedStatus {
  status: SessionStatus;
  reason: string;
}

/**
 * Maps the `status` field of `claude agents --json` to our states.
 * Only values we have observed are mapped; anything else is reported as
 * unknown together with the raw value rather than guessed.
 */
export function mapClaudeAgentsStatus(raw: unknown): MappedStatus {
  switch (raw) {
    case "busy":
      return { status: "running", reason: "Claude Code reports the session as busy." };
    case "idle":
      return {
        status: "waiting_for_input",
        reason: "Claude Code reports the session as idle at its prompt (turn finished or awaiting your next message).",
      };
    default:
      return {
        status: "unknown",
        reason: `Claude Code reported an unrecognised status (${typeof raw === "string" ? raw.slice(0, 40) : typeof raw}).`,
      };
  }
}
