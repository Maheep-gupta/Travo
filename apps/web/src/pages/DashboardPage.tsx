import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import type { ProviderId } from "@mc/contracts";
import { PROVIDERS, matchesFilter, needsAttention, relativeTime } from "@mc/domain";
import { useApi } from "../api-context.js";
import { DemoTag, EmptyState, ErrorState, PageHeader, SessionListSkeleton, StatusBadge } from "../components.js";
import { useNow, useSessionViews } from "../hooks.js";
import { IconFolder, IconHost, IconSearch, IconSessions } from "../icons.js";
import { STATUS_GROUPS, countByGroup, isStatusGroup, type SessionView, type StatusGroup } from "../view-model.js";

const GROUP_ORDER: StatusGroup[] = ["attention", "working", "done", "offline"];

export function DashboardPage() {
  const api = useApi();
  const { data, isLoading, error, refetch } = useSessionViews();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const groupParam = params.get("group");
  const group = isStatusGroup(groupParam) ? groupParam : null;
  const provider = params.get("provider") as ProviderId | null;
  const query = params.get("q") ?? "";

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const counts = useMemo(() => countByGroup(data ?? []), [data]);
  const providersPresent = useMemo(() => [...new Set((data ?? []).map((s) => s.provider))], [data]);
  const filtered = useMemo(
    () =>
      (data ?? []).filter((s) =>
        matchesFilter(s, {
          statuses: group ? STATUS_GROUPS[group].statuses : undefined,
          providers: provider ? [provider] : undefined,
          query,
        }),
      ),
    [data, group, provider, query],
  );
  const filtering = Boolean(group || provider || query);
  const attention = filtered.filter((s) => needsAttention(s.displayStatus));
  const rest = filtered.filter((s) => !needsAttention(s.displayStatus));

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
          <div className="overview" role="group" aria-label="Filter sessions by state">
            {GROUP_ORDER.map((g) => (
              <button
                key={g}
                type="button"
                className={`stat g-${g} ${g === "attention" && counts.attention > 0 ? "hot" : ""}`}
                aria-pressed={group === g}
                aria-label={`${STATUS_GROUPS[g].label}: ${counts[g]} ${counts[g] === 1 ? "session" : "sessions"}`}
                onClick={() => setParam("group", group === g ? null : g)}
              >
                <strong>{counts[g]}</strong>
                <span>
                  <span className="dot" aria-hidden="true" />
                  {STATUS_GROUPS[g].label}
                </span>
              </button>
            ))}
          </div>

          <div className="toolbar">
            <label className="search">
              <span className="sr-only">Search sessions</span>
              <IconSearch />
              <input
                className="input"
                type="search"
                placeholder="Search title, project or activity"
                value={query}
                onChange={(e) => setParam("q", e.target.value || null)}
              />
            </label>
            <label>
              <span className="sr-only">Integration</span>
              <select className="select" value={provider ?? ""} onChange={(e) => setParam("provider", e.target.value || null)}>
                <option value="">All integrations</option>
                {providersPresent.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {filtering && (
            <div className="active-filter" role="status">
              Showing {filtered.length} of {data?.length ?? 0}
              {group && <> · {STATUS_GROUPS[group].label}</>}
              <button type="button" className="btn ghost small" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
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
                <button type="button" className="btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
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

function SessionSection({ title, sessions, now }: { title: string; sessions: SessionView[]; now: Date }) {
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

function SessionCard({ session: s, now }: { session: SessionView; now: Date }) {
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
