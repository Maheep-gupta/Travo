import { Link, useParams } from "react-router";
import type { HostRow } from "@mc/contracts";
import { buildHostView, hostSourceOk, pageAvailability, relativeTime, syncWithRefreshes, type HostConnectivity } from "@mc/domain";
import { useApi } from "../api-context.js";
import { ConnectivityBadge, DemoTag, EmptyState, ErrorState, MissingDataNotice, RefreshFailedNotice, SessionListSkeleton, TruncatedNotice } from "../components.js";
import { useConnection, useHosts, useNow, useSessionViews } from "../hooks.js";
import { IconAlert, IconArrowLeft, IconHost } from "../icons.js";
import { FreshnessNote, SessionSection } from "./DashboardPage.js";

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Read-only host detail (spec 6.3). Revoking stays on the Hosts list so destructive actions live in one place. */
export function HostPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const now = useNow();
  const hosts = useHosts();
  const sessions = useSessionViews();
  // A failed refresh of the host list makes this host stale at once, judged as of its last fetch.
  const sync = syncWithRefreshes(useConnection(now).kind, [sessions.hosts]);
  const host = hosts.data?.find((h) => h.id === id);
  // The host is the subject; its sessions load separately and fail on their own.
  const availability = pageAvailability({ main: sessions.hosts });

  // Every state keeps a page-level h1 (visually hidden where the design has none).
  if (availability.kind === "loading") {
    return (
      <main className="page">
        <h1 className="sr-only">Host</h1>
        <SessionListSkeleton count={2} label="Loading host…" />
      </main>
    );
  }
  if (availability.kind !== "shown") {
    return (
      <main className="page">
        <h1 className="sr-only">Host</h1>
        <ErrorState error={hosts.error ?? new Error()} onRetry={() => void hosts.refetch()} />
      </main>
    );
  }
  if (!host) {
    return (
      <main className="page">
        <h1 className="sr-only">Host</h1>
        <EmptyState title="Host not found" icon={<IconHost />}>
          <p>It may have been removed, or it belongs to another account.</p>
          <Link to="/hosts" className="btn">
            Back to hosts
          </Link>
        </EmptyState>
      </main>
    );
  }

  const { connectivity, freshness } = buildHostView(host, now, { sync, fetchedAt: hosts.dataUpdatedAt });
  const own = (sessions.data ?? []).filter((s) => s.host_id === host.id);

  return (
    <main className="page">
      <Link to="/hosts" className="back">
        <IconArrowLeft />
        Hosts
      </Link>

      <header className="detail-head host-head">
        <div className="row">
          <ConnectivityBadge connectivity={connectivity} />
          {api.kind === "demo" && <DemoTag />}
        </div>
        <h1>{host.name}</h1>
      </header>
      <RefreshFailedNotice failure={sessions.refresh} now={now} onRetry={sessions.refetch} />
      {/* This host's sessions are picked from that list, so some may be missing. */}
      <TruncatedNotice truncated={sessions.truncated} dropped={sessions.dropped} />

      <div className="host-detail-grid">
        <section className="card" aria-labelledby="h-health">
          <div className="card-title">
            <h2 id="h-health">Health</h2>
          </div>
          <dl className="facts">
            <div>
              <dt>Connection</dt>
              <dd>
                {CONNECTION_TEXT[connectivity]}
                {/* Judged at the last refresh while Tavro can't refresh; never presented as now. */}
                {sync !== "current" && <> (as of Tavro's last refresh)</>}
              </dd>
            </div>
            <div>
              <dt>Last heartbeat</dt>
              <dd title={host.last_seen_at ? formatTime(host.last_seen_at) : undefined}>{relativeTime(host.last_seen_at, now)}</dd>
            </div>
            <div>
              <dt>Last update</dt>
              <dd>
                <FreshnessNote freshness={freshness} now={now} withReason />
              </dd>
            </div>
            <div>
              <dt>Session source</dt>
              <dd>
                <SourceState host={host} connectivity={connectivity} now={now} />
              </dd>
            </div>
          </dl>
        </section>

        <section className="card" aria-labelledby="h-identity">
          <div className="card-title">
            <h2 id="h-identity">Identity</h2>
          </div>
          <dl className="facts">
            <div>
              <dt>Platform</dt>
              <dd className="mono">{host.platform ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Connector</dt>
              <dd className="mono">{host.connector_version ?? "—"}</dd>
            </div>
            <div>
              <dt>Paired</dt>
              <dd title={host.paired_at ? formatTime(host.paired_at) : undefined}>
                {host.paired_at ? `${new Date(host.paired_at).toLocaleDateString()} (${relativeTime(host.paired_at, now)})` : "Not yet paired"}
              </dd>
            </div>
            {host.revoked_at && (
              <div>
                <dt>Revoked</dt>
                <dd title={formatTime(host.revoked_at)}>{relativeTime(host.revoked_at, now)}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      {sessions.sessions === "loading" ? (
        <div className="section">
          <SessionListSkeleton count={2} />
        </div>
      ) : sessions.sessions === "failed" ? (
        <div className="section">
          <MissingDataNotice title="Sessions couldn't be loaded." error={sessions.sessionsError} onRetry={sessions.refetchSessions}>
            <p>This host's details above are unaffected; its sessions appear once the session list loads.</p>
          </MissingDataNotice>
        </div>
      ) : own.length ? (
        <SessionSection title={`Sessions on ${host.name}`} sessions={own} now={now} />
      ) : (
        <div className="section">
          {sessions.truncated || sessions.dropped > 0 ? (
            // An incomplete list can't show that the host has none.
            <EmptyState title="No sessions from this host among those loaded">
              <p>Tavro's session list is incomplete, so this host may have sessions it didn't load.</p>
            </EmptyState>
          ) : (
            <EmptyState title="No sessions from this host">
              <p>Sessions appear here once its connector reports them.</p>
            </EmptyState>
          )}
        </div>
      )}
      {own.length > 0 && (
        <p className="host-dashboard-link">
          <Link to={`/?host=${encodeURIComponent(host.id)}`}>Filter the dashboard to this host</Link>
        </p>
      )}
    </main>
  );
}

const CONNECTION_TEXT: Record<HostConnectivity, string> = {
  online: "Online, heartbeating normally",
  disconnected: "Stopped reporting. Its sessions show as disconnected.",
  never_connected: "The connector has never reported in",
  revoked: "Access revoked. Pair again to reconnect.",
};

/** A source failure is only current while the host is online; otherwise it is the last report. */
function SourceState({ host, connectivity, now }: { host: HostRow; connectivity: HostConnectivity; now: Date }) {
  if (!hostSourceOk(host)) {
    return (
      <span className="host-warning">
        <IconAlert /> Can't read its sessions since {relativeTime(host.provider_error_since, now)}.
        {connectivity === "online" ? " Their status may be out of date until it recovers." : " Last report before the host stopped responding."}
      </span>
    );
  }
  return <>{connectivity === "online" ? "Reading sessions normally" : "Unknown while the host isn't reporting"}</>;
}
