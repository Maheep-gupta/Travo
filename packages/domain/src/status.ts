import type { SessionStatus } from "@mc/contracts";

/**
 * What the UI shows. Two states are never stored on a session; both are
 * derived because the last stored status can no longer be trusted:
 * - "disconnected": the session's host has stopped heartbeating.
 * - "source_unavailable": the host is reachable, but its session source
 *   (e.g. the Claude Code CLI) is failing, so statuses are not being refreshed.
 */
export type DisplayStatus = SessionStatus | "disconnected" | "source_unavailable";

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  running: "Working",
  waiting_for_input: "Waiting for you",
  approval_required: "Needs approval",
  completed: "Completed",
  failed: "Failed",
  ended: "Ended",
  disconnected: "Disconnected",
  source_unavailable: "Source not responding",
  unknown: "Unknown",
};

export function isDisplayStatus(value: string | null): value is DisplayStatus {
  // hasOwn, not `in`: "toString" and other prototype keys are not statuses.
  return value !== null && Object.hasOwn(STATUS_LABEL, value);
}

/** Lower rank = needs attention sooner. */
const ATTENTION_RANK: Record<DisplayStatus, number> = {
  approval_required: 0,
  waiting_for_input: 1,
  failed: 2,
  disconnected: 3,
  source_unavailable: 4,
  completed: 5,
  running: 6,
  unknown: 7,
  ended: 8,
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

/** status_reason for any provider status the mapping doesn't recognise. */
export const UNRECOGNISED_STATUS_REASON = "Unrecognised status from the provider.";

/**
 * Maps the `status` field of `claude agents --json` to our states.
 * Only values we have observed are mapped; anything else is reported as
 * unknown rather than guessed. That reason is fixed text: it syncs to the
 * cloud, and an unrecognised raw value could carry anything.
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
      return { status: "unknown", reason: UNRECOGNISED_STATUS_REASON };
  }
}
