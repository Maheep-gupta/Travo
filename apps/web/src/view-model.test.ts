import { describe, expect, it } from "vitest";
import type { HostRow, SessionRow } from "@mc/contracts";
import { STATUS_GROUPS, buildSessionViews, countByGroup, prefsEqual } from "./view-model.js";
import type { DisplayStatus } from "@mc/domain";

const now = new Date("2026-10-29T12:00:00Z");
const host = (id: string, lastSeenAgoMs: number | null): HostRow => ({
  id,
  owner_id: "00000000-0000-4000-8000-000000000001",
  name: id,
  platform: null,
  connector_version: null,
  remote_control_allowed: false,
  last_seen_at: lastSeenAgoMs === null ? null : new Date(now.getTime() - lastSeenAgoMs).toISOString(),
  paired_at: null,
  revoked_at: null,
  created_at: now.toISOString(),
});
const session = (id: string, hostId: string, status: SessionRow["status"]): SessionRow => ({
  id,
  owner_id: "00000000-0000-4000-8000-000000000001",
  host_id: hostId,
  provider: "mock",
  external_id: id,
  title: id,
  project_label: null,
  status,
  status_reason: null,
  status_source: "mock",
  last_activity_at: now.toISOString(),
  last_event_summary: null,
  capabilities: [],
  is_demo: true,
  started_at: null,
  ended_at: null,
  updated_at: now.toISOString(),
});

describe("buildSessionViews", () => {
  it("shows sessions on offline or unknown hosts as disconnected, and sorts by attention", () => {
    const views = buildSessionViews(
      [
        session("on-running", "online", "running"),
        session("off-waiting", "offline", "waiting_for_input"),
        session("orphan", "missing", "running"),
        session("on-approval", "online", "approval_required"),
      ],
      [host("online", 1000), host("offline", 10 * 60_000)],
      now,
    );
    expect(views.map((v) => [v.id, v.displayStatus])).toEqual([
      ["on-approval", "approval_required"],
      ["off-waiting", "disconnected"],
      ["orphan", "disconnected"],
      ["on-running", "running"],
    ]);
  });
});

describe("status groups", () => {
  it("assign every display status to exactly one group", () => {
    const all: DisplayStatus[] = ["running", "waiting_for_input", "approval_required", "completed", "failed", "ended", "disconnected", "unknown"];
    for (const s of all) {
      const groups = Object.values(STATUS_GROUPS).filter((g) => g.statuses.includes(s));
      expect(groups, s).toHaveLength(1);
    }
  });
  it("counts views per group", () => {
    const counts = countByGroup([{ displayStatus: "failed" }, { displayStatus: "approval_required" }, { displayStatus: "running" }, { displayStatus: "disconnected" }]);
    expect(counts).toEqual({ attention: 2, working: 1, done: 0, offline: 1 });
  });
});

describe("prefsEqual", () => {
  it("compares field by field", () => {
    const a = { on_failed: true, on_completed: false };
    expect(prefsEqual(a, { on_failed: true, on_completed: false })).toBe(true);
    expect(prefsEqual(a, { on_failed: true, on_completed: true })).toBe(false);
  });
});
