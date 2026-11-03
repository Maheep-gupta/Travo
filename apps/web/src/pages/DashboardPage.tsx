import { useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  EMPTY_DASHBOARD_FILTER,
  EXTRA_STATES,
  OVERVIEW_STATES,
  PROVIDERS,
  SEARCH_QUERY_MAX_LENGTH,
  SESSION_SORTS,
  STALE_REASON_LABEL,
  STATUS_GROUPS,
  STATUS_LABEL,
  applyDashboardFilter,
  buildHostView,
  countByState,
  countsAsOf,
  dashboardHeadline,
  formatDataTime,
  freshnessLabel,
  isFiltering,
  isSessionSort,
  needsAttention,
  normalizeSearchQuery,
  pageAvailability,
  parseDashboardFilter,
  projectOptions,
  relativeTime,
  trustedHostCount,
  unreadBySession,
  unreadCount,
  type DashboardFilter,
  type DisplayStatus,
  type Freshness,
  type SessionSort,
  type SessionView,
} from "@mc/domain";
import { useAlerts } from "../alerts-context.js";
import { useApi } from "../api-context.js";
import { DemoTag, EmptyState, ErrorState, MissingDataNotice, PageHeader, RefreshFailedNotice, SessionListSkeleton, StatusBadge } from "../components.js";
import { useConnection, useHosts, useNow, useSessionViews } from "../hooks.js";
import { IconBell, IconClock, IconClose, IconFolder, IconHost, IconSearch, IconSessions } from "../icons.js";
import { dashboardFilterParams, noMatchMessage, unreadAlertsLabel } from "../view-model.js";

const SORT_ORDER = Object.keys(SESSION_SORTS) as SessionSort[];

const HOST_NOT_LOADED_OPTION = "Host (not loaded)";

const plural = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

export function DashboardPage() {
  const api = useApi();
  const views = useSessionViews();
  const { data } = views;
  const hosts = useHosts();
  const now = useNow();
  // Sessions are the subject; hosts decide whether their statuses can be trusted, and still show if sessions fail.
  const availability = pageAvailability({ main: views.sessions, context: views.hosts, fallback: views.hosts });
  const [params, setParams] = useSearchParams();
  const parsed = parseDashboardFilter(params);
  // A well-formed host id that isn't one of ours is ignored like any other invalid value. Until the
  // host list is in, it can't be checked: it is kept (it still filters sessions by host id), so the
  // next filter change doesn't erase it from the URL.
  const hostsReady = hosts.data !== undefined;
  const hostKept = parsed.host !== null && (!hostsReady || hosts.data.some((h) => h.id === parsed.host));
  const filter: DashboardFilter = hostKept ? parsed : { ...parsed, host: null };
  const { group, state, host, project, provider, query, sort } = filter;
  const alerts = useAlerts();
  const unread = unreadCount(alerts);
  const unreadBySessionId = useMemo(() => unreadBySession(alerts), [alerts]);

  // Toggles, selects, sort and the clear buttons are history steps (Back undoes them);
  // typing in search replaces the entry so each keystroke isn't one.
  const update = (patch: Partial<DashboardFilter>, mode: "push" | "replace") =>
    setParams(dashboardFilterParams({ ...filter, ...patch }, params), { replace: mode === "replace" });

  // The box keeps exactly what was typed (spaces included); the URL holds the
  // trimmed query. When the URL changes another way (Back/Forward, a clear
  // button), the box follows it.
  const searchId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(query);
  const [shownQuery, setShownQuery] = useState(query);
  if (query !== shownQuery) {
    setShownQuery(query);
    if (normalizeSearchQuery(draft) !== query) setDraft(query);
  }
  const onSearch = (value: string) => {
    setDraft(value);
    if (normalizeSearchQuery(value) !== query) update({ query: value }, "replace");
  };
  const clearSearch = () => {
    setDraft("");
    if (query) update({ query: "" }, "push");
    searchInput.current?.focus();
  };
  // Clearing filters keeps the chosen sort.
  const clearFilters = () => {
    setDraft("");
    setParams(dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, sort }, params));
  };

  const counts = useMemo(() => countByState(data ?? []), [data]);
  const connection = useConnection(now);
  const hostClient = { sync: views.sync, fetchedAt: hosts.dataUpdatedAt };
  const onlineHosts = hosts.data ? hosts.data.filter((h) => buildHostView(h, now, hostClient).connectivity === "online").length : null;
  const title = dashboardHeadline({ counts: data ? counts : null, sync: views.sync, trustedHosts: trustedHostCount(hosts.data ?? null, now, hostClient) });
  const asOf = countsAsOf(connection, views.refresh);
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

  const filterLabels = [
    group && STATUS_GROUPS[group].label,
    state && STATUS_LABEL[state],
    host && (hostOptions.find((h) => h.id === host)?.name ?? HOST_NOT_LOADED_OPTION),
    project,
    provider && PROVIDERS[provider].label,
  ].filter((l): l is string => Boolean(l));
  const activeLabels = query ? [...filterLabels, `"${query}"`] : filterLabels;

  const allSelected = !group && !state;
  const toggleState = (s: DisplayStatus) => update({ group: null, state: state === s && !group ? null : s }, "push");
  const chipStates = [...OVERVIEW_STATES, ...EXTRA_STATES.filter((s) => counts.byState[s] > 0 || state === s)];

  return (
    <main className="page">
      <PageHeader eyebrow={api.kind === "demo" ? "Sessions · simulated" : "Sessions"} title={title}>
        {api.kind === "demo" ? (
          <>You're viewing demo data. Nothing here is real Claude activity.</>
        ) : (
          <>Live status from your paired hosts. Sessions that need you are listed first.</>
        )}
      </PageHeader>

      {/* Alerts are stored on this device, so they show even while sessions load or fail. */}
      {unread > 0 && (
        <p className="unread-summary">
          <IconBell />
          <Link to="/alerts">{unreadAlertsLabel(unread)}</Link>
        </p>
      )}

      {availability.kind === "loading" ? (
        <SessionListSkeleton />
      ) : availability.kind === "failed" ? (
        <ErrorState error={views.sessionsError ?? views.hostsError ?? new Error()} onRetry={views.refetch} />
      ) : availability.kind === "main_missing" ? (
        <MissingDataNotice title="Sessions couldn't be loaded." error={views.sessionsError} onRetry={views.refetchSessions}>
          <HostSummary total={hosts.data?.length ?? null} online={onlineHosts} />
        </MissingDataNotice>
      ) : (
        <>
          {availability.contextMissing && (
            <MissingDataNotice title="Host status couldn't be loaded." error={views.hostsError} onRetry={views.refetchHosts}>
              <p>Sessions show their last reported state, which may be out of date: Tavro can't tell whether their hosts are online until the host list loads.</p>
            </MissingDataNotice>
          )}
          <RefreshFailedNotice failure={views.refresh} now={now} onRetry={views.refetch} />
          {asOf !== null && (
            <p className="counts-as-of">
              <IconClock />
              Counts as of {formatDataTime(asOf, now.getTime())}
            </p>
          )}
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
            <div className="search-field">
              <label className="field-label" htmlFor={searchId}>
                Search sessions
              </label>
              <div className="search">
                <IconSearch />
                <input
                  id={searchId}
                  ref={searchInput}
                  className="input"
                  type="search"
                  placeholder="Title or project"
                  autoComplete="off"
                  value={draft}
                  maxLength={SEARCH_QUERY_MAX_LENGTH}
                  onChange={(e) => onSearch(e.target.value)}
                />
                {draft && (
                  <button type="button" className="search-clear" aria-label="Clear search" onClick={clearSearch}>
                    <IconClose />
                  </button>
                )}
              </div>
            </div>
            <label>
              <span className="sr-only">Host</span>
              <select className="select" value={host ?? ""} onChange={(e) => update({ host: e.target.value || null }, "push")}>
                <option value="">All hosts</option>
                {/* A URL-selected host kept while the host list isn't loaded. */}
                {host && !hostsReady && <option value={host}>{HOST_NOT_LOADED_OPTION}</option>}
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
              {hosts.data?.length === 0 ? (
                <EmptyState title="No hosts paired yet" icon={<IconHost />}>
                  <p>Pair the laptop where Claude Code runs; its sessions appear here once its connector reports them.</p>
                  <Link to="/hosts" className="btn">
                    Pair a host
                  </Link>
                </EmptyState>
              ) : (
                <EmptyState title="No sessions yet">
                  <p>
                    {onlineHosts === null
                      ? "Sessions appear here once a paired connector reports them."
                      : `${onlineHosts} of ${hosts.data?.length ?? 0} paired ${hosts.data?.length === 1 ? "host is" : "hosts are"} online. Sessions appear here once a connector reports them.`}
                  </p>
                  <Link to="/hosts" className="btn">
                    View hosts
                  </Link>
                </EmptyState>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="section">
              <EmptyState title="Nothing matches" icon={<IconSearch />}>
                <p>{noMatchMessage(query, filterLabels)}</p>
                <div className="actions">
                  {query && filterLabels.length > 0 && (
                    <button type="button" className="btn ghost" onClick={clearSearch}>
                      Clear search
                    </button>
                  )}
                  <button type="button" className="btn" onClick={clearFilters}>
                    {filterLabels.length ? "Clear filters" : "Clear search"}
                  </button>
                </div>
              </EmptyState>
            </div>
          ) : (
            <>
              {attention.length > 0 && <SessionSection title="Needs you" sessions={attention} now={now} unread={unreadBySessionId} />}
              {rest.length > 0 && (
                <SessionSection title={attention.length ? "Everything else" : "Sessions"} sessions={rest} now={now} unread={unreadBySessionId} />
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

/** What is still known while sessions can't load: the host list, judged like the Hosts page. */
function HostSummary({ total, online }: { total: number | null; online: number | null }) {
  if (total === null || online === null) return null;
  if (total === 0) {
    return (
      <p className="host-summary">
        No hosts are paired yet. <Link to="/hosts">Pair a host</Link>
      </p>
    );
  }
  return (
    <p className="host-summary">
      Your hosts loaded: {online} of {total} online. <Link to="/hosts">View hosts</Link>
    </p>
  );
}

export function SessionSection({
  title,
  sessions,
  now,
  unread,
}: {
  title: string;
  sessions: SessionView[];
  now: Date;
  /** Unread alerts per session id; cards with any say so. */
  unread?: ReadonlyMap<string, number>;
}) {
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
            <SessionCard session={s} now={now} unreadAlerts={unread?.get(s.id) ?? 0} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SessionCard({ session: s, now, unreadAlerts = 0 }: { session: SessionView; now: Date; unreadAlerts?: number }) {
  const attention = needsAttention(s.displayStatus);
  return (
    <Link
      to={`/sessions/${s.id}`}
      className={`session-card st-${s.displayStatus} ${attention ? "attention" : ""} ${unreadAlerts > 0 ? "has-unread" : ""}`}
    >
      <div className="sc-top">
        <StatusBadge status={s.displayStatus} />
        {s.is_demo && <DemoTag />}
        {unreadAlerts > 0 && (
          <span className="unread-tag">
            <IconBell />
            {unreadAlertsLabel(unreadAlerts)}
          </span>
        )}
        <span className="sc-time" title={s.last_activity_at ? `Last activity ${new Date(s.last_activity_at).toLocaleString()}` : undefined}>
          <span className="sr-only">Last activity </span>
          {relativeTime(s.last_activity_at, now)}
        </span>
      </div>
      <h3 className="sc-title">{s.title ?? s.external_id}</h3>
      {s.last_event_summary && <p className="sc-summary">{s.last_event_summary}</p>}
      <div className="sc-meta">
        <FreshnessNote freshness={s.freshness} now={now} />
        {s.project_label && (
          <span>
            <IconFolder />
            <span className="mono">{s.project_label}</span>
          </span>
        )}
        {/* No host list, no connectivity: the name says so and nothing claims online or offline. */}
        <span className={s.hostConnectivity === "online" || s.hostConnectivity === null ? undefined : "conn conn-disconnected"}>
          <IconHost />
          {s.hostName}
          {s.hostConnectivity !== "online" && s.hostConnectivity !== null && <> · offline</>}
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

/**
 * "Updated 5m ago" (last successful source read), with a text stale marker.
 * Shared by session cards, session and host detail, and host cards.
 */
export function FreshnessNote({ freshness: f, now, withReason = false }: { freshness: Freshness; now: Date; withReason?: boolean }) {
  return (
    <span
      className={`fresh ${f.stale ? "fresh-stale" : ""}`}
      title={f.lastReadAt ? `Last successful read ${f.stale ? "no later than " : ""}${new Date(f.lastReadAt).toLocaleString()}` : undefined}
    >
      <IconClock />
      {freshnessLabel(f, now)}
      {f.reason !== "current" && (
        <span className="stale-tag">
          {/* Spoken as part of the sentence; shown as a separate tag. */}
          <span className="sr-only">, </span>Stale{withReason && <>: {STALE_REASON_LABEL[f.reason]}</>}
        </span>
      )}
    </span>
  );
}
