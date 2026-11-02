import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { PROVIDERS, SESSION_SORTS, STATUS_LABEL, isSessionSort, needsAttention, relativeTime, type DisplayStatus, type SessionSort } from "@mc/domain";
import { useApi } from "../api-context.js";
import { DemoTag, EmptyState, ErrorState, PageHeader, SessionListSkeleton, StatusBadge } from "../components.js";
import { useHosts, useNow, useSessionViews } from "../hooks.js";
import { IconFolder, IconHost, IconSearch, IconSessions } from "../icons.js";
import {
  EMPTY_DASHBOARD_FILTER,
  EXTRA_STATES,
  MAX_QUERY_LENGTH,
  OVERVIEW_STATES,
  STATUS_GROUPS,
  applyDashboardFilter,
  countByState,
  dashboardFilterParams,
  isFiltering,
  parseDashboardFilter,
  projectOptions,
  type DashboardFilter,
  type SessionView,
} from "../view-model.js";

const SORT_ORDER = Object.keys(SESSION_SORTS) as SessionSort[];

const plural = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

export function DashboardPage() {
  const api = useApi();
  const { data, isLoading, error, refetch } = useSessionViews();
  const hosts = useHosts();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const parsed = parseDashboardFilter(params);
  // A well-formed host id that isn't one of ours is ignored like any other invalid value.
  const hostKnown = parsed.host !== null && (hosts.data ?? []).some((h) => h.id === parsed.host);
  const filter: DashboardFilter = hostKnown ? parsed : { ...parsed, host: null };
  const { group, state, host, project, provider, query, sort } = filter;

  // Toggles, selects and sort are history steps (Back undoes them);
  // typing in search replaces the entry so each keystroke isn't one.
  const update = (patch: Partial<DashboardFilter>, mode: "push" | "replace") =>
    setParams(dashboardFilterParams({ ...filter, ...patch }, params), { replace: mode === "replace" });
  // Clearing filters keeps the chosen sort.
  const clearFilters = () => setParams(dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, sort }, params));

  const counts = useMemo(() => countByState(data ?? []), [data]);
  const providersPresent = useMemo(() => [...new Set((data ?? []).map((s) => s.provider))], [data]);
  const projects = useMemo(() => projectOptions(data ?? []), [data]);
  const hostOptions = useMemo(
    () => [...(hosts.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : 1)),
    [hosts.data],
  );
  const filtered = applyDashboardFilter(data ?? [], filter);
  const filtering = isFiltering(filter);
  // The default order keeps the "Needs you" section; any other order is shown as one list, as chosen.
  const attention = sort === "attention" ? filtered.filter((s) => needsAttention(s.displayStatus)) : [];
  const rest = sort === "attention" ? filtered.filter((s) => !needsAttention(s.displayStatus)) : filtered;

  const activeLabels = [
    group && STATUS_GROUPS[group].label,
    state && STATUS_LABEL[state],
    host && hostOptions.find((h) => h.id === host)?.name,
    project,
    provider && PROVIDERS[provider].label,
    query.trim() && `"${query.trim()}"`,
  ].filter((l): l is string => Boolean(l));

  const allSelected = !group && !state;
  const toggleState = (s: DisplayStatus) => update({ group: null, state: state === s && !group ? null : s }, "push");
  const chipStates = [...OVERVIEW_STATES, ...EXTRA_STATES.filter((s) => counts.byState[s] > 0 || state === s)];

  return (
    <main className="page">
      <PageHeader eyebrow={api.kind === "demo" ? "Sessions · simulated" : "Sessions"} title={headline(data, counts.attention)}>
        {api.kind === "demo" ? (
          <>You're viewing demo data. Nothing here is real Claude activity.</>
        ) : (
          <>Live status from your paired hosts. Sessions that need you are listed first.</>
        )}
      </PageHeader>

      {isLoading ? (
        <SessionListSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <>
          <div className="overview overview-primary" role="group" aria-label="Filter sessions by attention">
            <button
              type="button"
              className={`stat g-attention ${counts.attention > 0 ? "hot" : ""}`}
              aria-pressed={group === "attention" && !state}
              aria-label={`${STATUS_GROUPS.attention.label}: ${plural(counts.attention)}`}
              onClick={() => update({ state: null, group: group === "attention" && !state ? null : "attention" }, "push")}
            >
              <strong>{counts.attention}</strong>
              <span>
                <span className="dot" aria-hidden="true" />
                {STATUS_GROUPS.attention.label}
              </span>
            </button>
            <button
              type="button"
              className="stat g-total"
              aria-pressed={allSelected}
              aria-label={`All: ${plural(counts.total)}`}
              onClick={() => update({ group: null, state: null }, "push")}
            >
              <strong>{counts.total}</strong>
              <span>All sessions</span>
            </button>
          </div>
          <div className="state-chips" role="group" aria-label="Filter sessions by state">
            {chipStates.map((s) => (
              <button
                key={s}
                type="button"
                className={`state-chip st-${s} ${counts.byState[s] === 0 ? "empty" : ""}`}
                aria-pressed={state === s && !group}
                aria-label={`${STATUS_LABEL[s]}: ${plural(counts.byState[s])}`}
                onClick={() => toggleState(s)}
              >
                <span className="dot" aria-hidden="true" />
                {STATUS_LABEL[s]}
                <b>{counts.byState[s]}</b>
              </button>
            ))}
          </div>

          <div className="toolbar dashboard-toolbar">
            <label className="search">
              <span className="sr-only">Search sessions</span>
              <IconSearch />
              <input
                className="input"
                type="search"
                placeholder="Search title, project or activity"
                value={query}
                maxLength={MAX_QUERY_LENGTH}
                onChange={(e) => update({ query: e.target.value }, "replace")}
              />
            </label>
            <label>
              <span className="sr-only">Host</span>
              <select className="select" value={host ?? ""} onChange={(e) => update({ host: e.target.value || null }, "push")}>
                <option value="">All hosts</option>
                {hostOptions.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Project</span>
              <select className="select" value={project ?? ""} onChange={(e) => update({ project: e.target.value || null }, "push")}>
                <option value="">All projects</option>
                {/* Keep a URL-selected project visible even when no session uses it right now. */}
                {(project && !projects.includes(project) ? [...projects, project] : projects).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Integration</span>
              <select
                className="select"
                value={provider ?? ""}
                onChange={(e) => update({ provider: parseDashboardFilter(new URLSearchParams({ provider: e.target.value })).provider }, "push")}
              >
                <option value="">All integrations</option>
                {/* Keep a URL-selected integration visible even when no session uses it right now. */}
                {(provider && !providersPresent.includes(provider) ? [...providersPresent, provider] : providersPresent).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Sort by</span>
              <select className="select" value={sort} onChange={(e) => isSessionSort(e.target.value) && update({ sort: e.target.value }, "push")}>
                {SORT_ORDER.map((s) => (
                  <option key={s} value={s}>
                    Sort: {SESSION_SORTS[s].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* Always mounted so the first filter change is announced; holds only the summary text. */}
          <p className="sr-only" role="status" aria-live="polite">
            {filtering ? `Showing ${filtered.length} of ${counts.total} sessions${activeLabels.length ? `, ${activeLabels.join(", ")}` : ""}` : ""}
          </p>
          {filtering && (
            <div className="active-filter">
              <span aria-hidden="true">
                Showing {filtered.length} of {counts.total}
                {activeLabels.map((l, i) => (
                  <span key={i}> · {l}</span>
                ))}
              </span>
              <button type="button" className="btn ghost small" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}

          {data?.length === 0 ? (
            <div className="section">
              <EmptyState title="No sessions yet">
                <p>Sessions appear here once a paired connector reports them.</p>
                <Link to="/hosts" className="btn">
                  Pair a host
                </Link>
              </EmptyState>
            </div>
          ) : filtered.length === 0 ? (
            <div className="section">
              <EmptyState title="Nothing matches" icon={<IconSearch />}>
                <p>Try a different search or clear the filters.</p>
                <button type="button" className="btn" onClick={clearFilters}>
                  Clear filters
                </button>
              </EmptyState>
            </div>
          ) : (
            <>
              {attention.length > 0 && <SessionSection title="Needs you" sessions={attention} now={now} />}
              {rest.length > 0 && <SessionSection title={attention.length ? "Everything else" : "Sessions"} sessions={rest} now={now} />}
            </>
          )}
        </>
      )}
    </main>
  );
}

function headline(data: SessionView[] | undefined, attention: number): string {
  if (!data) return "Sessions";
  if (data.length === 0) return "No sessions yet";
  if (attention === 0) return "All clear. Nothing needs you.";
  return attention === 1 ? "1 session needs you." : `${attention} sessions need you.`;
}

export function SessionSection({ title, sessions, now }: { title: string; sessions: SessionView[]; now: Date }) {
  const id = `section-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        <span className="count">{sessions.length}</span>
      </div>
      <ul className="session-list grid">
        {sessions.map((s) => (
          <li key={s.id}>
            <SessionCard session={s} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SessionCard({ session: s, now }: { session: SessionView; now: Date }) {
  const attention = needsAttention(s.displayStatus);
  return (
    <Link to={`/sessions/${s.id}`} className={`session-card st-${s.displayStatus} ${attention ? "attention" : ""}`}>
      <div className="sc-top">
        <StatusBadge status={s.displayStatus} />
        {s.is_demo && <DemoTag />}
        <span className="sc-time" title={s.last_activity_at ? new Date(s.last_activity_at).toLocaleString() : undefined}>
          {relativeTime(s.last_activity_at, now)}
        </span>
      </div>
      <h3 className="sc-title">{s.title ?? s.external_id}</h3>
      {s.last_event_summary && <p className="sc-summary">{s.last_event_summary}</p>}
      <div className="sc-meta">
        {s.project_label && (
          <span>
            <IconFolder />
            <span className="mono">{s.project_label}</span>
          </span>
        )}
        <span className={s.hostConnectivity === "online" ? undefined : "conn conn-disconnected"}>
          <IconHost />
          {s.hostName}
          {s.hostConnectivity !== "online" && <> · offline</>}
        </span>
        {s.provider !== "mock" && (
          <span>
            <IconSessions />
            {PROVIDERS[s.provider].label}
          </span>
        )}
      </div>
    </Link>
  );
}
