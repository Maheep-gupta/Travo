// What a session list left out (spec 3.1, 10.2; Part 16). The list is capped
// at SESSION_LIST_LIMIT, most recently active first, and a malformed row is
// dropped rather than failing the whole list. Both are said on screen, so
// counts are never presented as covering everything. Counts only: which rows
// were dropped, or why, never leaves the client's parser.
import { SESSION_LIST_LIMIT } from "@mc/contracts/constants";

export interface SessionListGaps {
  /** More sessions exist than the limit; only the most recently active are shown. */
  truncated: boolean;
  /** Rows that failed validation and are not shown. */
  dropped: number;
}

export const NO_SESSION_LIST_GAPS: SessionListGaps = { truncated: false, dropped: 0 };

/** Whether the list on screen is missing anything. */
export function hasSessionListGaps(gaps: SessionListGaps): boolean {
  return gaps.truncated || gaps.dropped > 0;
}

/**
 * One sentence per gap, in display order; empty when the list is complete. A
 * cut list with unreadable rows may show fewer than `limit` (valid rows fill
 * the cut first, but there may not be enough of them), so it says "up to".
 */
export function sessionListGapMessages(gaps: SessionListGaps, limit: number = SESSION_LIST_LIMIT): string[] {
  const messages: string[] = [];
  if (gaps.truncated && gaps.dropped > 0) messages.push(`Showing the newest sessions (up to ${limit}); counts cover only these.`);
  else if (gaps.truncated) messages.push(`Showing the ${limit} most recent sessions; counts cover only these.`);
  if (gaps.dropped === 1) messages.push("1 session couldn't be read and isn't shown.");
  else if (gaps.dropped > 1) messages.push(`${gaps.dropped} sessions couldn't be read and aren't shown.`);
  return messages;
}
