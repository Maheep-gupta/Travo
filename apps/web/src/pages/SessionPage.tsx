import { useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { Capability, SessionEventRow, SessionRow, SessionStatus } from "@mc/contracts";
import {
  ALERT_LABEL,
  EMPTY_DASHBOARD_FILTER,
  HEARTBEAT_INTERVAL_MS,
  PROVIDERS,
  STATUS_HISTORY_LIMIT,
  STATUS_LABEL,
  buildSessionViews,
  dashboardReturnPath,
  hasCapability,
  pageAvailability,
  relativeTime,
  sessionAlerts,
  sourceFailureText,
  sourceState,
  timelineCountLabel,
  timelineWindow,
  untrustedHostReason,
  type SessionView,
} from "@mc/domain";
import { useAlertStore, useAlerts } from "../alerts-context.js";
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
import { useHosts, useNow, useSessionViews, useStatusClock, userKey, useUserId, type SessionViewsResult } from "../hooks.js";
import { IconArrowLeft, IconBell, IconCheck, IconChevron, IconClose, IconFolder, IconHost, IconLock, IconSessions } from "../icons.js";
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
  const listed = sessions.data?.find((s) => s.id === id);
  const unlisted = useUnlistedSession(id, sessions, listed !== undefined);
  const session = listed ?? unlisted.view;
  const alerts = useAlerts();
  const store = useAlertStore();
  const alertsHeading = useRef<HTMLHeadingElement>(null);

  // Also fetched when the session list failed: the history is still worth showing on its own.
  const events = useQuery({
    queryKey: userKey(api, userId, "sessions", "events", id),
    queryFn: () => api.listEvents(id, STATUS_HISTORY_LIMIT, { asUser: userId }),
    enabled: Boolean(session) || sessions.sessions === "failed",
  });
  // Message content stays behind the session's own capability, so it never loads without the session.
  const canReadMessages = session ? hasCapability(session.capabilities, "read_messages") : false;
  const messages = useQuery({
    queryKey: userKey(api, userId, "sessions", "messages", id),
    queryFn: () => api.listMessages(id, 30, { asUser: userId }),
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
        <BackLink />
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
        <BackLink />
        <h1 className="sr-only">Session</h1>
        <MissingDataNotice title="Session details couldn't be loaded." error={sessions.sessionsError} onRetry={sessions.refetchSessions}>
          {/* The id isn't confirmed: the database answers an id that isn't yours with an empty history, not an error. */}
          <p>Its current state is unknown until the session list loads. If this session exists, its recorded history appears below.</p>
        </MissingDataNotice>
        <StatusHistory key={id} events={events} now={now} unconfirmed />
      </main>
    );
  }
  if (!session) {
    if (unlisted.lookingUp && unlisted.query.data === undefined) {
      return (
        <main className="page">
          <BackLink />
          <h1 className="sr-only">Session</h1>
          {unlisted.query.error ? (
            <ErrorState error={unlisted.query.error} onRetry={() => void unlisted.query.refetch()} />
          ) : (
            <SessionListSkeleton count={3} label="Loading session…" />
          )}
        </main>
      );
    }
    return (
      <main className="page">
        <h1 className="sr-only">Session</h1>
        <EmptyState title="Session not found">
          {unlisted.lookingUp ? (
            // The list on screen is incomplete, so not being in it says nothing; neither does an empty lookup, which is all RLS gives an id that isn't yours.
            <p>Tavro couldn't find this session in the sessions it loaded, and looking it up directly found nothing either. It may have ended and been removed.</p>
          ) : (
            <p>It may have ended and been removed, or it belongs to another account.</p>
          )}
          <BackLink className="btn">Back to sessions</BackLink>
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
  const unreadIds = related.filter((a) => !a.read).map((a) => a.id);
  // Read and dismissed only on request: opening the page marks nothing read. Focus moves
  // before the store changes, so it never falls back to the page when a button goes away.
  const markRead = (e: MouseEvent<HTMLButtonElement>, alertId: string) => {
    e.currentTarget.closest("li")?.querySelector<HTMLButtonElement>(".ra-dismiss")?.focus();
    store.markRead(alertId);
  };
  const dismiss = (alertId: string) => {
    alertsHeading.current?.focus();
    store.dismiss(alertId);
  };
  const markAllRead = () => {
    alertsHeading.current?.focus();
    store.markManyRead(unreadIds);
  };
  const dashboardLink = (patch: { host?: string; provider?: typeof session.provider }) =>
    `/?${dashboardFilterParams({ ...EMPTY_DASHBOARD_FILTER, ...patch }).toString()}`;

  return (
    <main className="page">
      <BackLink />

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
          <SourceUnavailableReason session={session} />
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
      {/* Looked up on its own (not in the incomplete list): its own refresh can fail too; it then ages like the list's. */}
      {!listed && unlisted.query.isError && (
        <MissingDataNotice title="Couldn't refresh this session." error={unlisted.query.error} onRetry={() => void unlisted.query.refetch()} />
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <StatusHistory key={id} events={events} now={now} />

          <section className="card" aria-labelledby="h-alerts">
            <div className="card-title">
              <h2 id="h-alerts" ref={alertsHeading} tabIndex={-1}>
                Alerts for this session
              </h2>
              {unreadIds.length > 0 && (
                <button type="button" className="btn small ghost ra-mark-all" onClick={markAllRead}>
                  Mark all read
                </button>
              )}
              <Link to="/alerts">All alerts</Link>
            </div>
            {related.length ? (
              <ul className="related-alerts">
                {related.map((a) => {
                  // Kind and time tell same-kind alerts apart for screen readers.
                  const name = `${ALERT_LABEL[a.kind]}, ${relativeTime(a.at, now)}`;
                  return (
                    <li key={a.id} className={a.read ? undefined : "unread"}>
                      <span className="ra-kind">{ALERT_LABEL[a.kind]}</span>
                      {!a.read && <span className="ra-unread">Unread</span>}
                      {a.isDemo && <DemoTag />}
                      <time dateTime={a.at} title={formatTime(a.at)}>
                        {relativeTime(a.at, now)}
                      </time>
                      <span className="ra-actions">
                        {!a.read && (
                          <button type="button" className="btn small ghost" aria-label={`Mark read: ${name}`} onClick={(e) => markRead(e, a.id)}>
                            Mark read
                          </button>
                        )}
                        <button type="button" className="icon-btn ra-dismiss" aria-label={`Dismiss alert: ${name}`} onClick={() => dismiss(a.id)}>
                          <IconClose />
                        </button>
                      </span>
                    </li>
                  );
                })}
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

/**
 * "Sessions": back to the dashboard list this session was opened from, filters
 * included (spec 3.3), else the unfiltered dashboard. The href is always real,
 * so new tabs and direct links work. When the session was opened from that
 * list in this tab, a plain click steps back to it instead of pushing it again:
 * Back afterwards doesn't loop to the session, and the browser restores the
 * list's scroll position (route-focus keeps it on POP).
 *
 * Only the first click steps back: a fast double tap would otherwise step back
 * twice, past the list. Whether the entry before this one still exists can't
 * be told reliably from a page, so there is no fallback for history that was
 * replaced under it; the href stays correct for every other way of opening it.
 */
function BackLink({ className = "back", children }: { className?: string; children?: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  // The entry a step back was already taken from; the page normally unmounts before a second click.
  const steppedBackFrom = useRef<string | null>(null);
  const returnTo = dashboardReturnPath(location.state);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Only a dashboard card link writes the origin, so the entry before this one is that list. "default": no earlier in-app entry.
    if (returnTo === null || location.key === "default") return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (steppedBackFrom.current === location.key) return;
    steppedBackFrom.current = location.key;
    void navigate(-1);
  };
  return (
    <Link to={returnTo ?? "/"} className={className} onClick={onClick}>
      {children ?? (
        <>
          <IconArrowLeft />
          Sessions
        </>
      )}
    </Link>
  );
}

/**
 * Why a session behind a failing source may be out of date: the host page's
 * wording (sourceFailureText), what to do only while the host is online, and
 * a link to the host. The host row comes from the shared host list query.
 */
function SourceUnavailableReason({ session }: { session: SessionView }) {
  const hosts = useHosts();
  const failure = sourceFailureText(hosts.data?.find((h) => h.id === session.host_id)?.provider_error_kind);
  return (
    <>
      <p className="reason">
        <strong>{failure.summary},</strong> so this state may be out of date. Last reported: {STATUS_LABEL[session.status]}.
      </p>
      <p className="reason">
        {failure.title}.{session.hostConnectivity === "online" && ` ${failure.guidance}`}{" "}
        <Link to={`/hosts/${session.host_id}`}>View {session.hostName}</Link>
      </p>
    </>
  );
}

/**
 * A session the loaded list doesn't include, looked up on its own while that
 * list is incomplete (cut at the limit, or rows left out): only a complete
 * list settles that a session isn't there. Built like the list's sessions, so
 * a host that is missing (or a host list that is) leaves it untrusted.
 */
function useUnlistedSession(id: string, views: SessionViewsResult, listed: boolean): {
  /** The lookup is in use: the list is on screen, incomplete, and lacks this id. */
  lookingUp: boolean;
  query: UseQueryResult<SessionRow | null>;
  view: SessionView | undefined;
} {
  const api = useApi();
  const userId = useUserId();
  const hosts = useHosts();
  // The clock the list's views are judged by.
  const now = useStatusClock();
  const lookingUp = views.data !== undefined && !listed && (views.truncated || views.dropped > 0);
  // Not a status list (see isStatusQuery); polled like one while it stands in for the list.
  const query = useQuery({
    queryKey: userKey(api, userId, "sessions", "detail", id),
    queryFn: () => api.getSession(id, { asUser: userId }),
    enabled: lookingUp,
    refetchInterval: lookingUp ? HEARTBEAT_INTERVAL_MS : false,
  });
  const row = lookingUp ? query.data : undefined;
  const view = useMemo(
    () =>
      row
        ? buildSessionViews([row], hosts.data ?? null, now, { sync: views.sync, sessionsFetchedAt: query.dataUpdatedAt, hostsFetchedAt: hosts.dataUpdatedAt })[0]
        : undefined,
    [row, hosts.data, hosts.dataUpdatedAt, now, views.sync, query.dataUpdatedAt],
  );
  return { lookingUp, query, view };
}

/** The session's recorded status changes; shown on its own when the session list fails. */
/** `unconfirmed`: the session itself couldn't be loaded, so an empty history mustn't suggest it exists. */
/** A long history shows its newest events and folds the older ones behind a button (mobile review M2). */
function StatusHistory({ events, now, unconfirmed = false }: { events: UseQueryResult<SessionEventRow[]>; now: Date; unconfirmed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const loaded = events.data ?? [];
  const fold = timelineWindow(loaded, expanded);
  return (
    <section className="card" aria-labelledby="h-history">
      <div className="card-title">
        <h2 id="h-history">Status history</h2>
        {events.data && <span className="eyebrow">{timelineCountLabel(events.data.length)}</span>}
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
        <>
          <ol className="timeline" id={listId}>
            {fold.shown.map((e) => {
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
          {/* Stays below the list in both states, so focus doesn't jump; aria-expanded says what changed. */}
          {fold.foldable && (
            <button
              type="button"
              className="btn ghost small timeline-more"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
            >
              <IconChevron className={expanded ? "open" : undefined} />
              {expanded ? "Show fewer" : `Show ${fold.hidden} older ${fold.hidden === 1 ? "event" : "events"}`}
            </button>
          )}
        </>
      ) : (
        <p className="muted">{unconfirmed ? "No recorded history to show." : "No status changes recorded yet."}</p>
      )}
    </section>
  );
}
