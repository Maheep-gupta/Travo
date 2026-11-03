import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { Capability, SessionEventRow, SessionStatus } from "@mc/contracts";
import {
  ALERT_LABEL,
  EMPTY_DASHBOARD_FILTER,
  PROVIDERS,
  STATUS_LABEL,
  hasCapability,
  pageAvailability,
  relativeTime,
  sessionAlerts,
  sourceState,
  untrustedHostReason,
} from "@mc/domain";
import { useAlerts } from "../alerts-context.js";
import { useApi } from "../api-context.js";
import {
  ConnectivityBadge,
  DemoTag,
  EmptyState,
  ErrorState,
  MissingDataNotice,
  RefreshFailedNotice,
  SessionListSkeleton,
  Spinner,
  StatusBadge,
} from "../components.js";
import { useNow, useSessionViews, userKey, useUserId } from "../hooks.js";
import { IconArrowLeft, IconBell, IconCheck, IconFolder, IconHost, IconLock, IconSessions } from "../icons.js";
import { dashboardFilterParams } from "../view-model.js";
import { FreshnessNote } from "./DashboardPage.js";

const CAPABILITY_LABEL: Record<Capability, string> = {
  discover: "Discover sessions",
  get_details: "Session details",
  read_messages: "Read recent messages",
  subscribe_events: "Live status updates",
  send_message: "Reply to the session",
  resume: "Resume the session",
  approve_requests: "Approve permission prompts",
};
const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABEL) as Capability[];

const STATUS_SOURCE_LABEL: Record<string, string> = {
  cli_agents_list: "Claude Code session list",
  hook: "Claude Code hook",
  transcript: "Transcript",
  mock: "Simulator (demo)",
  derived: "Derived by connector",
};

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const HOLLOW: ReadonlySet<SessionStatus> = new Set(["ended", "unknown"]);

export function SessionPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const userId = useUserId();
  const now = useNow();
  const sessions = useSessionViews();
  const session = sessions.data?.find((s) => s.id === id);
  const alerts = useAlerts();

  // Also fetched when the session list failed: the history is still worth showing on its own.
  const events = useQuery({
    queryKey: userKey(api, userId, "sessions", "events", id),
    queryFn: () => api.listEvents(id, 100),
    enabled: Boolean(session) || sessions.sessions === "failed",
  });
  // Message content stays behind the session's own capability, so it never loads without the session.
  const canReadMessages = session ? hasCapability(session.capabilities, "read_messages") : false;
  const messages = useQuery({
    queryKey: userKey(api, userId, "sessions", "messages", id),
    queryFn: () => api.listMessages(id, 30),
    enabled: canReadMessages,
  });
  const availability = pageAvailability({
    main: sessions.sessions,
    context: sessions.hosts,
    fallback: sourceState({ hasData: events.data !== undefined, failed: events.isError }),
  });

  // Every state keeps a page-level h1 (visually hidden where the design has none).
  if (availability.kind === "loading") {
    return (
      <main className="page">
        <h1 className="sr-only">Session</h1>
        <SessionListSkeleton count={3} label="Loading session…" />
      </main>
    );
  }
  if (availability.kind === "failed") {
    return (
      <main className="page">
        <h1 className="sr-only">Session</h1>
        <ErrorState
          error={sessions.sessionsError ?? new Error()}
          onRetry={() => {
            sessions.refetchSessions();
            void events.refetch();
          }}
        />
      </main>
    );
  }
  if (availability.kind === "main_missing") {
    return (
      <main className="page">
        <Link to="/" className="back">
          <IconArrowLeft />
          Sessions
        </Link>
        <h1 className="sr-only">Session</h1>
        <MissingDataNotice title="Session details couldn't be loaded." error={sessions.sessionsError} onRetry={sessions.refetchSessions}>
          {/* The id isn't confirmed: the database answers an id that isn't yours with an empty history, not an error. */}
          <p>Its current state is unknown until the session list loads. If this session exists, its recorded history appears below.</p>
        </MissingDataNotice>
        <StatusHistory events={events} now={now} unconfirmed />
      </main>
    );
  }
  if (!session) {
    return (
      <main className="page">
        <h1 className="sr-only">Session</h1>
        <EmptyState title="Session not found">
          <p>It may have ended and been removed, or it belongs to another account.</p>
          <Link to="/" className="btn">
            Back to sessions
          </Link>
        </EmptyState>
      </main>
    );
  }

  const provider = PROVIDERS[session.provider];
  const available = ALL_CAPABILITIES.filter((c) => hasCapability(session.capabilities, c));
  const unavailable = ALL_CAPABILITIES.filter((c) => !hasCapability(session.capabilities, c));
  const canReply = hasCapability(session.capabilities, "send_message");
  // Without the host list the status is as last reported: never vouched for, so its reason isn't shown either.
  const hostsMissing = session.hostConnectivity === null;
  const untrusted = hostsMissing || session.displayStatus === "disconnected" || session.displayStatus === "source_unavailable";
  const reasonText = untrusted ? null : session.status_reason;
  const related = sessionAlerts(alerts, session.id);
  const dashboardLink = (patch: { host?: string; provider?: typeof session.provider }) =>
    `/?${dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, ...patch }).toString()}`;

  return (
    <main className="page">
      <Link to="/" className="back">
        <IconArrowLeft />
        Sessions
      </Link>

      <header className={`detail-head st-${session.displayStatus}`}>
        <div className="row">
          <StatusBadge status={session.displayStatus} variant="lg" />
          {session.is_demo && <DemoTag />}
        </div>
        <h1>{session.title ?? session.external_id}</h1>
        <div className="sub">
          {session.project_label && (
            <span>
              <IconFolder />
              <span className="mono">{session.project_label}</span>
            </span>
          )}
          <span>
            <IconHost />
            {session.hostName}
          </span>
          <span>
            <IconSessions />
            {provider.label}
          </span>
          <FreshnessNote freshness={session.freshness} now={now} withReason />
        </div>
        {session.displayStatus === "source_unavailable" ? (
          <p className="reason">
            <strong>{session.hostName} is online but can't read its sessions right now,</strong> so this state may be out of date. Last reported:{" "}
            {STATUS_LABEL[session.status]}.
          </p>
        ) : session.displayStatus === "disconnected" ? (
          <p className="reason">
            <strong>{untrustedHostReason(session.hostConnectivity, session.hostName)},</strong> so this session's current state is unknown. Last reported:{" "}
            {STATUS_LABEL[session.status]}.
          </p>
        ) : (
          (reasonText || session.last_event_summary) && (
            <p className="reason">
              {session.last_event_summary && <strong>{session.last_event_summary}. </strong>}
              {reasonText}
            </p>
          )
        )}
      </header>

      {availability.kind === "shown" && availability.contextMissing && (
        <MissingDataNotice title="Host status couldn't be loaded." error={sessions.hostsError} onRetry={sessions.refetchHosts}>
          <p>This is the session's last reported state. Whether its host is online, and whether that state is current, is unknown until the host list loads.</p>
        </MissingDataNotice>
      )}
      <RefreshFailedNotice failure={sessions.refresh} now={now} onRetry={sessions.refetch} />

      <div className="detail-grid">
        <div className="detail-main">
          <StatusHistory events={events} now={now} />

          <section className="card" aria-labelledby="h-alerts">
            <div className="card-title">
              <h2 id="h-alerts">Alerts for this session</h2>
              <Link to="/alerts">All alerts</Link>
            </div>
            {related.length ? (
              <ul className="related-alerts">
                {related.map((a) => (
                  <li key={a.id} className={a.read ? undefined : "unread"}>
                    <span className="ra-kind">{ALERT_LABEL[a.kind]}</span>
                    {!a.read && <span className="ra-unread">Unread</span>}
                    {a.isDemo && <DemoTag />}
                    <time dateTime={a.at} title={formatTime(a.at)}>
                      {relativeTime(a.at, now)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted related-empty">
                <IconBell />
                No alerts for this session while Tavro has been open on this device.
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="h-messages">
            <div className="card-title">
              <h2 id="h-messages">Recent messages</h2>
              {session.is_demo && <DemoTag />}
            </div>
            {/* A failed refresh keeps the messages that loaded. */}
            {canReadMessages && messages.data !== undefined && messages.isError && (
              <MissingDataNotice title="Couldn't refresh the messages." error={messages.error} onRetry={() => void messages.refetch()} />
            )}
            {!canReadMessages ? (
              <p className="muted">This integration doesn't provide message content.</p>
            ) : messages.data === undefined ? (
              messages.error ? (
                <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
              ) : (
                <Spinner />
              )
            ) : messages.data.length ? (
              <ol className="transcript">
                {messages.data.map((m) => (
                  <li key={m.external_uuid} className={`msg msg-${m.role}`}>
                    <div className="msg-head">
                      {m.role === "assistant" ? "Claude" : m.role}
                      {m.occurred_at && (
                        <time dateTime={m.occurred_at} title={formatTime(m.occurred_at)}>
                          {relativeTime(m.occurred_at, now)}
                        </time>
                      )}
                    </div>
                    <p>{m.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">
                No messages stored. Transcript excerpts are only kept in a database on your own laptop, and only when enabled in the connector.
              </p>
            )}
          </section>
        </div>

        <aside className="detail-side" aria-label="Session details">
          <section className="card" aria-labelledby="h-reply">
            <div className="card-title">
              <h2 id="h-reply">Remote control</h2>
            </div>
            {canReply ? (
              <p>This integration reports reply support, but Tavro does not send replies in this release.</p>
            ) : (
              <div className="locked">
                <div className="row">
                  <IconLock />
                  <strong>Replies are off for this session</strong>
                </div>
                <p>{provider.limitation}</p>
                <p className="next">{provider.continueIn}</p>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="h-details">
            <div className="card-title">
              <h2 id="h-details">Details</h2>
            </div>
            <dl className="facts">
              <div>
                <dt>Host</dt>
                <dd>
                  {session.hostName}
                  <br />
                  {session.hostConnectivity === null ? (
                    <span className="muted">Status unknown</span>
                  ) : (
                    <ConnectivityBadge connectivity={session.hostConnectivity} />
                  )}
                </dd>
              </div>
              <div>
                <dt>Last activity</dt>
                <dd title={formatTime(session.last_activity_at)}>{relativeTime(session.last_activity_at, now)}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{formatTime(session.started_at)}</dd>
              </div>
              <div>
                <dt>Status from</dt>
                <dd>{STATUS_SOURCE_LABEL[session.status_source] ?? session.status_source}</dd>
              </div>
              <div>
                <dt>Session ID</dt>
                <dd className="mono">{session.external_id}</dd>
              </div>
            </dl>
            <ul className="session-filters" aria-label="Find similar sessions">
              {!hostsMissing && session.freshness.reason !== "host_unknown" && (
                <li>
                  <Link to={dashboardLink({ host: session.host_id })}>All sessions on {session.hostName}</Link>
                </li>
              )}
              <li>
                <Link to={dashboardLink({ provider: session.provider })}>All {provider.label} sessions</Link>
              </li>
            </ul>
          </section>

          <section className="card" aria-labelledby="h-caps">
            <div className="card-title">
              <h2 id="h-caps">What Tavro can do here</h2>
            </div>
            <div className="caps-group">
              <div className="caps-label">Available</div>
              <ul className="caps">
                {available.map((c) => (
                  <li key={c} className="on">
                    <IconCheck />
                    {CAPABILITY_LABEL[c]}
                  </li>
                ))}
              </ul>
            </div>
            {unavailable.length > 0 && (
              <div className="caps-group">
                <div className="caps-label">Not available</div>
                <ul className="caps">
                  {unavailable.map((c) => (
                    <li key={c} className="off">
                      <IconLock />
                      {CAPABILITY_LABEL[c]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

/** The session's recorded status changes; shown on its own when the session list fails. */
/** `unconfirmed`: the session itself couldn't be loaded, so an empty history mustn't suggest it exists. */
function StatusHistory({ events, now, unconfirmed = false }: { events: UseQueryResult<SessionEventRow[]>; now: Date; unconfirmed?: boolean }) {
  return (
    <section className="card" aria-labelledby="h-history">
      <div className="card-title">
        <h2 id="h-history">Status history</h2>
        {events.data && <span className="eyebrow">{events.data.length} events</span>}
      </div>
      {/* A failed refresh keeps the history that loaded. */}
      {events.data !== undefined && events.isError && (
        <MissingDataNotice title="Couldn't refresh the history." error={events.error} onRetry={() => void events.refetch()} />
      )}
      {events.data === undefined ? (
        events.error ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : (
          <Spinner />
        )
      ) : events.data.length ? (
        <ol className="timeline">
          {events.data.map((e) => {
            const st = e.status ?? "unknown";
            return (
              <li key={e.id} className={`st-${st}`}>
                <span className={`tl-dot ${HOLLOW.has(st) || e.type === "session_ended" ? "hollow" : ""}`} aria-hidden="true" />
                <div className="tl-body">
                  <div className="tl-head">
                    <b>
                      {e.type === "session_discovered"
                        ? `Discovered · ${STATUS_LABEL[st]}`
                        : e.type === "session_ended"
                          ? "Session ended"
                          : STATUS_LABEL[st]}
                    </b>
                    {e.is_demo && <DemoTag />}
                    <time className="tl-time" dateTime={e.occurred_at} title={formatTime(e.occurred_at)}>
                      {relativeTime(e.occurred_at, now)}
                    </time>
                  </div>
                  {e.summary && <p>{e.summary}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">{unconfirmed ? "No recorded history to show." : "No status changes recorded yet."}</p>
      )}
    </section>
  );
}
