import { describe, expect, it } from "vitest";
import {
  DASHBOARD_FILTER_KEYS,
  DASHBOARD_ORIGIN_MAX_LENGTH,
  EMPTY_DASHBOARD_FILTER,
  collapsedFilterCount,
  EXTRA_STATES,
  HOST_DERIVED_STATES,
  OVERVIEW_STATES,
  SEARCH_QUERY_MAX_LENGTH,
  STATUS_GROUPS,
  STATUS_LABEL,
  applyDashboardFilter,
  buildSessionViews,
  countByState,
  dashboardFilterValues,
  dashboardOrigin,
  dashboardReturnPath,
  isDisplayStatus,
  isFiltering,
  isStatusGroup,
  needsAttention,
  parseDashboardFilter,
  projectOptions,
  unknownStateCounts,
  unknownStateMessage,
  type DashboardFilter,
  type DisplayStatus,
  type FilterParams,
} from "../src/index.js";
import { CURRENT, host, now, session } from "./fixtures.js";

const ALL = Object.keys(STATUS_LABEL) as DisplayStatus[];

/** A plain reader, as a native client would build from its router's params. */
const params = (values: Record<string, string>): FilterParams => ({ get: (name) => (Object.hasOwn(values, name) ? (values[name] ?? null) : null) });

describe("status groups", () => {
  it("assign every display status to exactly one group", () => {
    for (const s of ALL) {
      const groups = Object.values(STATUS_GROUPS).filter((g) => g.statuses.includes(s));
      expect(groups, s).toHaveLength(1);
    }
  });

  it("put exactly the statuses that need attention in Need you", () => {
    expect(ALL.filter(needsAttention).sort()).toEqual([...STATUS_GROUPS.attention.statuses].sort());
  });

  it("reject prototype keys", () => {
    expect(isStatusGroup("__proto__")).toBe(false);
    expect(isStatusGroup("toString")).toBe(false);
    expect(isDisplayStatus("constructor")).toBe(false);
    expect(isDisplayStatus("failed")).toBe(true);
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

describe("dashboard filter parameters", () => {
  const H = "00000000-0000-4000-8000-0000000000A1";

  it("reads valid values through any reader, normalising the host id and query", () => {
    const f = parseDashboardFilter(params({ group: "attention", state: "failed", host: H, project: "payments-api", provider: "mock", q: "  deploy ", sort: "recent" }));
    expect(f).toEqual({ group: "attention", state: "failed", host: H.toLowerCase(), project: "payments-api", provider: "mock", query: "deploy", sort: "recent" });
  });

  it("treats unknown, prototype-named, malformed and missing values as no filter", () => {
    expect(parseDashboardFilter(params({}))).toEqual(EMPTY_DASHBOARD_FILTER);
    expect(parseDashboardFilter(params({ group: "toString", state: "constructor", provider: "__proto__", sort: "fastest" }))).toEqual(EMPTY_DASHBOARD_FILTER);
    expect(parseDashboardFilter(params({ host: "../etc", project: "x".repeat(201), q: "a\u0000b" }))).toEqual(EMPTY_DASHBOARD_FILTER);
    expect(parseDashboardFilter(params({ q: "x".repeat(500) })).query).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
  });

  it("writes null for empty values and the default sort, in key order", () => {
    expect(dashboardFilterValues(EMPTY_DASHBOARD_FILTER)).toEqual(Object.fromEntries(DASHBOARD_FILTER_KEYS.map((k) => [k, null])));
    expect(Object.keys(dashboardFilterValues(EMPTY_DASHBOARD_FILTER))).toEqual([...DASHBOARD_FILTER_KEYS]);
    expect(dashboardFilterValues({ ...EMPTY_DASHBOARD_FILTER, query: " bad\u0007", project: "", sort: "host" })).toMatchObject({ q: null, project: null, sort: "host" });
  });

  it("round-trips through the written values", () => {
    const f: DashboardFilter = { group: "offline", state: "disconnected", host: H.toLowerCase(), project: "docs", provider: "claude-code", query: "fix tests", sort: "project" };
    const written = dashboardFilterValues(f);
    expect(parseDashboardFilter({ get: (name) => written[name as keyof typeof written] ?? null })).toEqual(f);
  });

  it("counts only real filters as filtering, not the sort or a blank query", () => {
    expect(isFiltering(EMPTY_DASHBOARD_FILTER)).toBe(false);
    expect(isFiltering({ ...EMPTY_DASHBOARD_FILTER, sort: "recent" })).toBe(false);
    expect(isFiltering({ ...EMPTY_DASHBOARD_FILTER, query: " \t" })).toBe(false);
    expect(isFiltering({ ...EMPTY_DASHBOARD_FILTER, project: "docs" })).toBe(true);
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
    CURRENT,
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

  it("searches title and project, combined with the other filters", () => {
    // Fixture titles are the ids.
    expect(ids({ query: "API" })).toEqual(["c-fail", "a-run"]);
    expect(ids({ query: "fail" })).toEqual(["c-fail"]);
    expect(ids({ query: "api", host: "h1" })).toEqual(["a-run"]);
    expect(ids({ query: "api", state: "completed" })).toEqual([]);
    expect(ids({ query: "   " })).toHaveLength(4);
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

describe("unknownStateCounts", () => {
  it("marks Disconnected and Source not responding unknown while the host list is missing, and nothing once it loads", () => {
    expect([...unknownStateCounts({ hostsLoaded: false })].sort()).toEqual(["disconnected", "source_unavailable"]);
    expect(unknownStateCounts({ hostsLoaded: true }).size).toBe(0);
  });

  it("covers exactly the states only the host list can produce", () => {
    // Without hosts every session keeps its stored status, so the host-derived counts are always 0: not evidence.
    const stored = ALL.filter((s): s is Exclude<DisplayStatus, "disconnected" | "source_unavailable"> => !HOST_DERIVED_STATES.includes(s));
    const counts = countByState(buildSessionViews(stored.map((s) => session(s, "h1", s)), null, now, CURRENT));
    for (const s of HOST_DERIVED_STATES) expect(counts.byState[s], s).toBe(0);
    for (const s of stored) expect(counts.byState[s], s).toBe(1);
    // Every unknown count is one the overview shows.
    for (const s of HOST_DERIVED_STATES) expect(OVERVIEW_STATES).toContain(s);
    // With the host list, a session can be Disconnected: its host stopped heartbeating.
    const withHosts = buildSessionViews([session("x", "h1", "running")], [host("h1", 60 * 60_000)], now, CURRENT);
    expect(withHosts[0]?.displayStatus).toBe("disconnected");
  });

  it("says why a filter to an unknown state is empty, and stays out of the way otherwise", () => {
    const unknown = unknownStateCounts({ hostsLoaded: false });
    expect(unknownStateMessage("disconnected", unknown)).toBe("Host status isn't loaded, so Tavro can't tell which sessions are disconnected right now.");
    expect(unknownStateMessage("source_unavailable", unknown)).toMatch(/^Host status isn't loaded, so Tavro can't tell /);
    expect(unknownStateMessage("running", unknown)).toBeNull();
    expect(unknownStateMessage(null, unknown)).toBeNull();
    expect(unknownStateMessage("disconnected", unknownStateCounts({ hostsLoaded: true }))).toBeNull();
  });
});

describe("dashboardReturnPath", () => {
  it("round-trips the dashboard's own origin, filters included", () => {
    expect(dashboardReturnPath(dashboardOrigin("?state=failed&q=memory%20leak"))).toBe("/?state=failed&q=memory%20leak");
    expect(dashboardReturnPath(dashboardOrigin(""))).toBe("/");
    expect(dashboardReturnPath(dashboardOrigin("?"))).toBe("/");
  });

  it("rejects anything that isn't the dashboard path with a search string", () => {
    for (const state of [
      undefined,
      null,
      "/?state=failed",
      42,
      {},
      { dashboardOrigin: null },
      { dashboardOrigin: "/?q=x" },
      { dashboardOrigin: { pathname: "/alerts", search: "" } },
      { dashboardOrigin: { pathname: "//evil.example", search: "" } },
      { dashboardOrigin: { pathname: "https://evil.example/", search: "" } },
      { dashboardOrigin: { search: "?q=x" } },
      { dashboardOrigin: { pathname: "/", search: 1 } },
      // A search that could leave the path or carry more than a query.
      { dashboardOrigin: { pathname: "/", search: "/evil.example" } },
      { dashboardOrigin: { pathname: "/", search: "evil.example" } },
      { dashboardOrigin: { pathname: "/", search: "?q=x#top" } },
      { dashboardOrigin: { pathname: "/", search: "?q=a b" } },
      { dashboardOrigin: { pathname: "/", search: "?q=a\nb" } },
      { dashboardOrigin: { pathname: "/", search: `?q=${"x".repeat(DASHBOARD_ORIGIN_MAX_LENGTH)}` } },
    ]) {
      expect(dashboardReturnPath(state), JSON.stringify(state)).toBeNull();
    }
  });

  it("ignores an inherited origin", () => {
    const inherited = Object.create({ dashboardOrigin: { pathname: "/", search: "?q=x" } }) as object;
    expect(dashboardReturnPath(inherited)).toBeNull();
  });
});

describe("collapsedFilterCount (narrow-screen Filters button, H4b)", () => {
  it("counts host, project, integration and a non-default sort", () => {
    expect(collapsedFilterCount(EMPTY_DASHBOARD_FILTER)).toBe(0);
    expect(collapsedFilterCount({ ...EMPTY_DASHBOARD_FILTER, host: "h1", project: "api" })).toBe(2);
    expect(collapsedFilterCount({ ...EMPTY_DASHBOARD_FILTER, provider: "mock", sort: "recent" })).toBe(2);
  });

  it("ignores what stays visible outside the disclosure (search, state chips)", () => {
    expect(collapsedFilterCount({ ...EMPTY_DASHBOARD_FILTER, query: "x", state: "failed", group: "attention" })).toBe(0);
  });
});
