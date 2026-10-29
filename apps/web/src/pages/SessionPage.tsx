import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { Capability, SessionStatus } from "@mc/contracts";
import { PROVIDERS, STATUS_LABEL, hasCapability, relativeTime } from "@mc/domain";
import { useApi } from "../api-context.js";
import { ConnectivityBadge, DemoTag, EmptyState, ErrorState, SessionListSkeleton, Spinner, StatusBadge } from "../components.js";
import { useNow, useSessionViews } from "../hooks.js";
import { IconArrowLeft, IconCheck, IconFolder, IconHost, IconLock, IconSessions } from "../icons.js";

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
  const now = useNow();
  const sessions = useSessionViews();
  const session = sessions.data?.find((s) => s.id === id);

  const events = useQuery({
    queryKey: ["sessions", api.kind, "events", id],
    queryFn: () => api.listEvents(id, 100),
    enabled: Boolean(session),
  });
  const canReadMessages = session ? hasCapability(session.capabilities, "read_messages") : false;
  const messages = useQuery({
    queryKey: ["sessions", api.kind, "messages", id],
    queryFn: () => api.listMessages(id, 30),
    enabled: canReadMessages,
  });

  if (sessions.isLoading) {
    return (
      <main className="page">
        <SessionListSkeleton count={3} />
      </main>
    );
  }
  if (sessions.error) {
    return (
      <main className="page">
        <ErrorState error={sessions.error} onRetry={sessions.refetch} />
      </main>
    );
  }
  if (!session) {
    return (
      <main className="page">
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
  const reasonText =
    session.displayStatus === "disconnected" ? null : session.status_reason;

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
        </div>
        {session.displayStatus === "disconnected" ? (
          <p className="reason">
            <strong>{session.hostName} has stopped reporting,</strong> so this session's current state is unknown. Last reported:{" "}
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

      <div className="detail-grid">
        <div className="detail-main">
          <section className="card" aria-labelledby="h-history">
            <div className="card-title">
              <h2 id="h-history">Status history</h2>
              {events.data && <span className="eyebrow">{events.data.length} events</span>}
            </div>
            {events.isLoading ? (
              <Spinner />
            ) : events.error ? (
              <ErrorState error={events.error} onRetry={() => void events.refetch()} />
            ) : events.data?.length ? (
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
              <p className="muted">No status changes recorded yet.</p>
            )}
          </section>

          <section className="card" aria-labelledby="h-messages">
            <div className="card-title">
              <h2 id="h-messages">Recent messages</h2>
              {session.is_demo && <DemoTag />}
            </div>
            {!canReadMessages ? (
              <p className="muted">This integration doesn't provide message content.</p>
            ) : messages.isLoading ? (
              <Spinner />
            ) : messages.error ? (
              <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
            ) : messages.data?.length ? (
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
              <p>Replies are supported for this session.</p>
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
                  <ConnectivityBadge connectivity={session.hostConnectivity} />
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
