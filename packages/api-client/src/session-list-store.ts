import { NO_SESSION_LIST_GAPS, hasSessionListGaps, type SessionListGaps } from "@mc/domain";
import type { SessionListInfo } from "./api.js";

/** The implementation side of SessionListInfo, shared by every backend. */
export interface SessionListStore extends SessionListInfo {
  /** Call when a list request starts; pass the token to `report` when it succeeds. */
  begin(): number;
  /** Records a successful list's gaps, unless `reset` ran after its `begin` (a previous user's request). */
  report(token: number, gaps: SessionListGaps): void;
  /** Forgets the gaps (sign-out, Change backend). */
  reset(): void;
  /**
   * The signed-in user, from the backend's auth events. A different user than
   * before (e.g. another tab signed in as someone else) resets, so the previous
   * user's late response can't describe the new user's list. The first call only records.
   */
  setUser(userId: string | null): void;
}

export function createSessionListStore(): SessionListStore {
  let current: SessionListGaps | null = null;
  let generation = 0;
  // Undefined until the backend first says who is signed in.
  let user: string | null | undefined;
  const listeners = new Set<() => void>();
  const set = (next: SessionListGaps | null) => {
    // Unchanged gaps keep the same object, so readers don't re-render on every poll.
    const same = next === null ? current === null : current !== null && current.truncated === next.truncated && current.dropped === next.dropped;
    if (same) return;
    current = next === null ? null : hasSessionListGaps(next) ? { truncated: next.truncated, dropped: next.dropped } : NO_SESSION_LIST_GAPS;
    for (const l of listeners) l();
  };
  const reset = () => {
    generation++;
    set(null);
  };
  return {
    gaps: () => current,
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    begin: () => generation,
    report(token, gaps) {
      if (token === generation) set(gaps);
    },
    reset,
    setUser(userId) {
      if (user !== undefined && user !== userId) reset();
      user = userId;
    },
  };
}
