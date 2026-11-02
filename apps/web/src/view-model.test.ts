import { describe, expect, it } from "vitest";
import type { HostRow, SessionRow } from "@mc/contracts";
import {
  EMPTY_DASHBOARD_FILTER,
  EXTRA_STATES,
  MAX_QUERY_LENGTH,
  OVERVIEW_STATES,
  STATUS_GROUPS,
  applyDashboardFilter,
  buildSessionViews,
  countByState,
  dashboardFilterParams,
  isDisplayStatus,
  isFiltering,
  isStatusGroup,
  parseDashboardFilter,
  prefsEqual,
  projectOptions,
  type DashboardFilter,
} from "./view-model.js";
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
  provider_error_since: null,
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

  it("never shows a stale stored status behind a host whose session source is failing", () => {
    const failing = { ...host("failing", 1000), provider_error_since: new Date(now.getTime() - 60_000).toISOString() };
    const views = buildSessionViews([session("a", "failing", "running"), session("b", "failing", "ended")], [failing], now);
    expect(views.map((v) => [v.id, v.displayStatus])).toEqual([
      ["a", "source_unavailable"],
      ["b", "ended"],
    ]);
    expect(countByState(views).byState.source_unavailable).toBe(1);
  });
});

describe("status groups", () => {
  it("assign every display status to exactly one group", () => {
    const all: DisplayStatus[] = ["running", "waiting_for_input", "approval_required", "completed", "failed", "ended", "disconnected", "source_unavailable", "unknown"];
    for (const s of all) {
      const groups = Object.values(STATUS_GROUPS).filter((g) => g.statuses.includes(s));
      expect(groups, s).toHaveLength(1);
    }
  });
});

describe("prefsEqual", () => {
  it("compares field by field", () => {
    const a = { on_failed: true, on_completed: false };
    expect(prefsEqual(a, { on_failed: true, on_completed: false })).toBe(true);
    expect(prefsEqual(a, { on_failed: true, on_completed: true })).toBe(false);
  });
});

describe("dashboard filter in the URL", () => {
  it("parses valid values", () => {
    expect(parseDashboardFilter(new URLSearchParams("group=attention&provider=mock&q=deploy"))).toEqual({ ...EMPTY_DASHBOARD_FILTER, group: "attention", provider: "mock", query: "deploy" });
  });

  it("treats unknown, prototype-named and missing values as no filter", () => {
    expect(parseDashboardFilter(new URLSearchParams("group=toString&provider=constructor"))).toEqual(EMPTY_DASHBOARD_FILTER);
    expect(parseDashboardFilter(new URLSearchParams("group=nope&provider=xyz"))).toEqual(EMPTY_DASHBOARD_FILTER);
    expect(isStatusGroup("__proto__")).toBe(false);
  });

  it("caps the search query length", () => {
    expect(parseDashboardFilter(new URLSearchParams({ q: "x".repeat(500) })).query).toHaveLength(MAX_QUERY_LENGTH);
  });

  it("serialises, omitting empty values and keeping unrelated params", () => {
    const base = new URLSearchParams("demo=1&q=old");
    expect(dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, group: "done", query: "  " }, base).toString()).toBe("demo=1&group=done");
    expect(dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, provider: "mock", query: "abc" }).toString()).toBe("provider=mock&q=abc");
  });

  it("round-trips", () => {
    const f: DashboardFilter = { ...EMPTY_DASHBOARD_FILTER, group: "offline", provider: "claude-code", query: "fix tests" };
    expect(parseDashboardFilter(dashboardFilterParams(f))).toEqual(f);
  });
});

describe("per-state overview counts", () => {
  it("counts the total, the Need you group and every display state", () => {
    const counts = countByState([
      { displayStatus: "approval_required" },
      { displayStatus: "waiting_for_input" },
      { displayStatus: "failed" },
      { displayStatus: "running" },
      { displayStatus: "running" },
      { displayStatus: "source_unavailable" },
      { displayStatus: "ended" },
    ]);
    expect(counts.total).toBe(7);
    expect(counts.attention).toBe(3);
    expect(counts.byState).toEqual({
      running: 2,
      waiting_for_input: 1,
      approval_required: 1,
      completed: 0,
      failed: 1,
      ended: 1,
      disconnected: 0,
      source_unavailable: 1,
      unknown: 0,
    });
  });

  it("lists every display state exactly once across the spec and extra chips", () => {
    const all = [...OVERVIEW_STATES, ...EXTRA_STATES];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(Object.keys(countByState([]).byState).length);
  });
});

describe("dashboard state, host, project and sort params", () => {
  const H = "00000000-0000-4000-8000-0000000000A1";

  it("parses valid values, normalising the host id", () => {
    const f = parseDashboardFilter(new URLSearchParams(`state=failed&host=${H}&project=payments-api&sort=recent`));
    expect(f).toEqual({ ...EMPTY_DASHBOARD_FILTER, state: "failed", host: H.toLowerCase(), project: "payments-api", sort: "recent" });
  });

  it("ignores invalid values", () => {
    const f = parseDashboardFilter(new URLSearchParams(`state=toString&host=../etc&project=${"x".repeat(201)}&sort=__proto__`));
    expect(f).toEqual(EMPTY_DASHBOARD_FILTER);
    expect(parseDashboardFilter(new URLSearchParams("state=bogus&sort=fastest&project=")).sort).toBe("attention");
    expect(isDisplayStatus("constructor")).toBe(false);
  });

  it("omits the default sort and round-trips everything else", () => {
    expect(dashboardFilterParams(EMPTY_DASHBOARD_FILTER).toString()).toBe("");
    const f: DashboardFilter = { group: "attention", state: "failed", host: H.toLowerCase(), project: "docs", provider: "mock", query: "x", sort: "host" };
    expect(parseDashboardFilter(dashboardFilterParams(f))).toEqual(f);
    expect(isFiltering(EMPTY_DASHBOARD_FILTER)).toBe(false);
    expect(isFiltering({ ...EMPTY_DASHBOARD_FILTER, sort: "recent" })).toBe(false);
    expect(isFiltering({ ...EMPTY_DASHBOARD_FILTER, project: "docs" })).toBe(true);
  });

  it("keeps old group links working", () => {
    expect(parseDashboardFilter(new URLSearchParams("group=offline")).group).toBe("offline");
  });
});

describe("applyDashboardFilter", () => {
  const views = buildSessionViews(
    [
      { ...session("a-run", "h1", "running"), project_label: "api" },
      { ...session("b-wait", "h1", "waiting_for_input"), project_label: "web" },
      { ...session("c-fail", "h2", "failed"), project_label: "api" },
      { ...session("d-done", "h2", "completed"), project_label: null },
    ],
    [host("h1", 1000), host("h2", 1000)],
    now,
  );
  const ids = (f: Partial<DashboardFilter>) => applyDashboardFilter(views, { ...EMPTY_DASHBOARD_FILTER, ...f }).map((v) => v.id);

  it("composes state, host, project and query filters", () => {
    expect(ids({})).toEqual(["b-wait", "c-fail", "d-done", "a-run"]);
    expect(ids({ state: "failed" })).toEqual(["c-fail"]);
    expect(ids({ host: "h1" })).toEqual(["b-wait", "a-run"]);
    expect(ids({ project: "api" })).toEqual(["c-fail", "a-run"]);
    expect(ids({ project: "api", host: "h1" })).toEqual(["a-run"]);
    expect(ids({ group: "attention", host: "h2" })).toEqual(["c-fail"]);
  });

  it("matches nothing when a legacy group and a state don't overlap", () => {
    expect(ids({ group: "working", state: "failed" })).toEqual([]);
    expect(ids({ group: "attention", state: "failed" })).toEqual(["c-fail"]);
  });

  it("applies the chosen sort deterministically when timestamps are equal", () => {
    // Every fixture has the same last_activity_at, so the id decides.
    expect(ids({ sort: "recent" })).toEqual(["a-run", "b-wait", "c-fail", "d-done"]);
    expect(ids({ sort: "working" })).toEqual(["a-run", "b-wait", "c-fail", "d-done"]);
    expect(ids({ sort: "completed" })).toEqual(["d-done", "a-run", "b-wait", "c-fail"]);
    expect(ids({ sort: "project" })).toEqual(["c-fail", "a-run", "b-wait", "d-done"]);
  });

  it("lists distinct projects alphabetically", () => {
    expect(projectOptions(views)).toEqual(["api", "web"]);
  });
});
