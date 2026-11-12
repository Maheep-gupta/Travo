import { describe, expect, it } from "vitest";
import { STATUS_HISTORY_LIMIT, TIMELINE_FOLD_SLACK, TIMELINE_INITIAL, timelineCountLabel, timelineWindow } from "../src/index.js";

const events = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("timelineWindow", () => {
  it("shows a short history whole, with no control", () => {
    expect(timelineWindow([], false)).toEqual({ shown: [], hidden: 0, foldable: false });
    expect(timelineWindow(events(TIMELINE_INITIAL), false)).toEqual({ shown: events(TIMELINE_INITIAL), hidden: 0, foldable: false });
  });

  it("doesn't fold away only a couple of rows", () => {
    const n = TIMELINE_INITIAL + TIMELINE_FOLD_SLACK;
    expect(timelineWindow(events(n), false)).toEqual({ shown: events(n), hidden: 0, foldable: false });
  });

  it("folds a long history to its newest events and counts the rest", () => {
    const n = TIMELINE_INITIAL + TIMELINE_FOLD_SLACK + 1;
    const w = timelineWindow(events(n), false);
    expect(w.shown).toEqual(events(TIMELINE_INITIAL));
    expect(w.hidden).toBe(n - TIMELINE_INITIAL);
    expect(w.foldable).toBe(true);
  });

  it("shows everything when expanded, and stays foldable so it can collapse again", () => {
    expect(timelineWindow(events(40), true)).toEqual({ shown: events(40), hidden: 0, foldable: true });
  });

  it("keeps the order it was given (newest first) and a sane minimum", () => {
    expect(timelineWindow(["c", "b", "a", "z"], false, 1, 0).shown).toEqual(["c"]);
    expect(timelineWindow(events(5), false, 0, 0).shown).toEqual([0]);
  });
});

describe("timelineCountLabel", () => {
  it("counts a complete history", () => {
    expect(timelineCountLabel(0)).toBe("0 events");
    expect(timelineCountLabel(1)).toBe("1 event");
    expect(timelineCountLabel(12)).toBe("12 events");
  });

  it("doesn't present a full page as the whole history", () => {
    expect(timelineCountLabel(STATUS_HISTORY_LIMIT)).toBe(`Latest ${STATUS_HISTORY_LIMIT} events`);
    expect(timelineCountLabel(5, 5)).toBe("Latest 5 events");
  });
});
