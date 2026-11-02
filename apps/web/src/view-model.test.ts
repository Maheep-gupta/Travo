import { describe, expect, it } from "vitest";
import {
  EMPTY_DASHBOARD_FILTER,
  SEARCH_QUERY_MAX_LENGTH,
  isDisplayStatus,
  isFiltering,
  isStatusGroup,
  parseDashboardFilter,
  sessionAlerts,
  unreadBySession,
  type DashboardFilter,
  type StoredAlert,
} from "@mc/domain";
import { dashboardFilterParams, noMatchMessage, prefsEqual, unreadAlertsLabel } from "./view-model.js";

// Session views, pairing, overview counts and filter application are pinned in
// packages/domain/test. These cover what stays in the web app: the URL
// encoding (URLSearchParams in and out) and copy, plus the per-session alert
// rules from @mc/domain/alerts that the dashboard and session page depend on.

describe("sessionAlerts", () => {
  const alert = (id: string, sessionId: string | null, at: string): StoredAlert => ({
    id,
    kind: sessionId ? "completed" : "host_disconnected",
    sessionId,
    hostId: "h1",
    at,
    isDemo: true,
    read: false,
  });

  it("keeps only the session's own alerts, newest first", () => {
    const list = [
      alert("old", "s1", "2026-10-29T10:00:00Z"),
      alert("other", "s2", "2026-10-29T11:30:00Z"),
      alert("host", null, "2026-10-29T11:45:00Z"),
      alert("new", "s1", "2026-10-29T11:00:00Z"),
    ];
    expect(sessionAlerts(list, "s1").map((a) => a.id)).toEqual(["new", "old"]);
    expect(sessionAlerts(list, "none")).toEqual([]);
  });

  it("counts unread alerts per session, ignoring read and host alerts", () => {
    const list = [
      alert("a", "s1", "2026-10-29T10:00:00Z"),
      alert("b", "s1", "2026-10-29T11:00:00Z"),
      { ...alert("c", "s2", "2026-10-29T11:00:00Z"), read: true },
      alert("d", null, "2026-10-29T11:00:00Z"),
    ];
    expect([...unreadBySession(list)]).toEqual([["s1", 2]]);
    expect(unreadBySession([]).size).toBe(0);
    expect(unreadAlertsLabel(1)).toBe("1 unread alert");
    expect(unreadAlertsLabel(3)).toBe("3 unread alerts");
  });
});

describe("noMatchMessage", () => {
  it("names the active search and filters", () => {
    expect(noMatchMessage("  deploy ", [])).toBe('No sessions match the search "deploy".');
    expect(noMatchMessage("", ["Failed"])).toBe("No sessions match the filter Failed.");
    expect(noMatchMessage("deploy", ["Failed", "docs"])).toBe('No sessions match the search "deploy" with the filters Failed, docs.');
    expect(noMatchMessage("", [])).toBe("No sessions match.");
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
    expect(parseDashboardFilter(new URLSearchParams({ q: "x".repeat(500) })).query).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
  });

  it("trims the search query and ignores invalid ones", () => {
    expect(parseDashboardFilter(new URLSearchParams({ q: "  deploy  " })).query).toBe("deploy");
    expect(parseDashboardFilter(new URLSearchParams({ q: "   " })).query).toBe("");
    expect(parseDashboardFilter(new URLSearchParams({ q: "a\u0000b" })).query).toBe("");
    expect(dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, query: "  fix tests " }).toString()).toBe("q=fix+tests");
    expect(dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, query: "bad\u0007" }).toString()).toBe("");
    expect(isFiltering({ ...EMPTY_DASHBOARD_FILTER, query: " \t" })).toBe(false);
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

