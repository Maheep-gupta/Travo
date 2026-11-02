import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ALERT_LABEL, groupAlerts, relativeTime, unreadCount, type AlertKind, type StoredAlert } from "@mc/domain";
import { alertHref, useAlerts, useAlertStore } from "../alerts-context.js";
import { DemoTag, EmptyState, Notice, PageHeader } from "../components.js";
import { useHosts, useNow, useSessionViews } from "../hooks.js";
import { IconBell, IconChevron, IconClose } from "../icons.js";

/** Alert kinds reuse the status colour tokens so they read like the dashboard. */
const KIND_TONE: Record<AlertKind, string> = {
  approval_required: "st-approval_required",
  waiting_for_input: "st-waiting_for_input",
  failed: "st-failed",
  completed: "st-completed",
  host_disconnected: "st-disconnected",
  host_reconnected: "st-running",
  source_unavailable: "st-source_unavailable",
  source_recovered: "st-running",
};

/**
 * Heading for a folded burst (groupAlerts folds only these families). It counts
 * alerts, not sessions: one session can finish twice in a burst.
 */
function groupTitle(kind: AlertKind, n: number): string {
  const what = kind === "completed" ? "Completed" : kind === "waiting_for_input" ? "Waiting for you" : kind.startsWith("host_") ? "Connection changes" : "Session source changes";
  return `${what} · ${n} alerts`;
}

export function AlertsPage() {
  const alerts = useAlerts();
  const store = useAlertStore();
  const now = useNow(30_000);
  const sessions = useSessionViews();
  const hosts = useHosts();
  const [confirmClear, setConfirmClear] = useState(false);
  // Groups start folded. Expansion is remembered by member alert ids, so a
  // group stays open when one of its alerts is dismissed or it regroups.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (ids: readonly string[], open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (open) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  // Names come from live data; stored alerts hold identifiers only.
  const sessionName = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title ?? s.project_label ?? "Untitled session"])), [sessions.data]);
  const hostName = useMemo(() => new Map((hosts.data ?? []).map((h) => [h.id, h.name])), [hosts.data]);

  const unread = unreadCount(alerts);
  const groups = useMemo(() => groupAlerts(alerts), [alerts]);

  const describe = (a: StoredAlert) => {
    if (a.sessionId) return sessionName.get(a.sessionId) ?? "A session that is no longer listed";
    return hostName.get(a.hostId) ?? "A host that is no longer listed";
  };

  const renderRow = (a: StoredAlert): ReactNode => (
    <li key={a.id} className={`alert-item ${KIND_TONE[a.kind]}${a.read ? "" : " unread"}`}>
      <span className="dot" aria-hidden="true" />
      <div className="alert-body">
        <Link to={alertHref(a)} className="alert-link" onClick={() => store.markRead(a.id)}>
          <span className="alert-kind">{ALERT_LABEL[a.kind]}</span>
          <span className="alert-name">{describe(a)}</span>
          {!a.read && <span className="sr-only"> (unread)</span>}
        </Link>
        <span className="alert-meta">
          <time dateTime={a.at}>{relativeTime(a.at, now)}</time>
          {a.sessionId && hostName.get(a.hostId) && <span>· {hostName.get(a.hostId)}</span>}
          {a.isDemo && <DemoTag />}
        </span>
      </div>
      <div className="alert-actions">
        {!a.read && (
          <button type="button" className="btn small ghost" onClick={() => store.markRead(a.id)}>
            Mark read
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => store.dismiss(a.id)} aria-label={`Dismiss alert: ${ALERT_LABEL[a.kind]}, ${describe(a)}`}>
          <IconClose />
        </button>
      </div>
    </li>
  );

  return (
    <main className="page medium">
      <PageHeader eyebrow="Alerts" title="Alerts">
        Sessions and hosts that needed your attention while Tavro was open.
      </PageHeader>

      <Notice>
        Alerts are detected while Tavro is open. Nothing is delivered when it's closed: background push isn't available yet.{" "}
        <Link to="/settings">Notification settings</Link>
      </Notice>

      {alerts.length === 0 ? (
        <EmptyState title="No alerts" icon={<IconBell />}>
          <p className="muted">When a session needs approval, is waiting for you, fails or finishes, it shows up here.</p>
        </EmptyState>
      ) : (
        <section className="section" aria-labelledby="h-alerts">
          <div className="section-head">
            <h2 id="h-alerts">
              {unread > 0 ? `${unread} unread` : "All read"} <span className="count">· {alerts.length} total</span>
            </h2>
            <div className="row">
              <button type="button" className="btn small ghost" onClick={() => store.markAllRead()} disabled={unread === 0}>
                Mark all read
              </button>
              {confirmClear ? (
                <>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => {
                      store.clear();
                      setConfirmClear(false);
                    }}
                  >
                    Confirm clear all
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="btn small ghost" onClick={() => setConfirmClear(true)}>
                  Clear all
                </button>
              )}
            </div>
          </div>
          <ul className="alert-list">
            {groups.map((g) => {
              const first = g.latest;
              if (g.alerts.length === 1) return renderRow(first);
              const open = g.alerts.some((a) => expanded.has(a.id));
              const listId = `alert-group-${g.id.replace(/[^A-Za-z0-9-]/g, "-")}`;
              const ids = g.alerts.map((a) => a.id);
              const title = groupTitle(first.kind, g.alerts.length);
              const host = hostName.get(first.hostId) ?? "A host that is no longer listed";
              return (
                <li key={g.id} className={`alert-item alert-group ${KIND_TONE[first.kind]}${g.unread ? " unread" : ""}`}>
                  <span className="dot" aria-hidden="true" />
                  <div className="alert-body">
                    <button type="button" className="alert-link group-toggle" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => toggle(ids, open)}>
                      <span className="alert-kind">
                        {title} <IconChevron className={open ? "open" : undefined} />
                      </span>
                      <span className="alert-name">{host}</span>
                      {g.unread > 0 && <span className="sr-only"> ({g.unread} unread)</span>}
                    </button>
                    <span className="alert-meta">
                      <span>Latest: {ALERT_LABEL[first.kind]}</span>
                      <time dateTime={first.at}>· {relativeTime(first.at, now)}</time>
                      {first.isDemo && <DemoTag />}
                    </span>
                  </div>
                  <div className="alert-actions">
                    {g.unread > 0 && (
                      <button type="button" className="btn small ghost" onClick={() => store.markManyRead(ids)}>
                        Mark {g.unread} read
                      </button>
                    )}
                    <button type="button" className="icon-btn" onClick={() => store.dismissMany(ids)} aria-label={`Dismiss ${g.alerts.length} alerts: ${title}, ${host}`}>
                      <IconClose />
                    </button>
                  </div>
                  {open && (
                    <ul id={listId} className="alert-list alert-group-items">
                      {g.alerts.map(renderRow)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
