// A session's status history on its page (spec 13, mobile review M2). The
// history is fetched newest first, up to STATUS_HISTORY_LIMIT events. A long
// history is folded to its newest few so the rest of the page stays reachable
// on a phone; a "Show all" control reveals the rest. Counts say when the fetch
// itself was cut, so "100 events" never reads as the whole history.

/** The most events one status-history request asks for. */
export const STATUS_HISTORY_LIMIT = 100;

/** Events shown before the list is folded. */
export const TIMELINE_INITIAL = 8;

/**
 * Folding is skipped when it would hide only this many events or fewer: a
 * "Show 2 more" control costs as much room as the two rows it hides.
 */
export const TIMELINE_FOLD_SLACK = 2;

export interface TimelineWindow<T> {
  /** The events to render, newest first. */
  shown: readonly T[];
  /** Events loaded but folded away; 0 when everything loaded is shown. */
  hidden: number;
  /** Whether a show-all / show-fewer control is needed at all. */
  foldable: boolean;
}

/** Which loaded events to render. `events` must already be newest first. */
export function timelineWindow<T>(
  events: readonly T[],
  expanded: boolean,
  initial: number = TIMELINE_INITIAL,
  slack: number = TIMELINE_FOLD_SLACK,
): TimelineWindow<T> {
  const limit = Math.max(1, Math.floor(initial));
  const foldable = events.length > limit + Math.max(0, slack);
  if (!foldable || expanded) return { shown: events, hidden: 0, foldable };
  return { shown: events.slice(0, limit), hidden: events.length - limit, foldable };
}

/**
 * The count beside the heading. A full page of results may be a cut history,
 * so it says "latest" rather than claiming a total.
 */
export function timelineCountLabel(loaded: number, limit: number = STATUS_HISTORY_LIMIT): string {
  const noun = loaded === 1 ? "event" : "events";
  return loaded >= limit ? `Latest ${loaded} ${noun}` : `${loaded} ${noun}`;
}
