import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ALERT_LABEL, relativeTime, unreadCount, type AlertKind, type StoredAlert } from "@mc/domain";
import { alertHref, useAlerts, useAlertStore } from "../alerts-context.js";
import { DemoTag, EmptyState, Notice, PageHeader } from "../components.js";
import { useHosts, useNow, useSessionViews } from "../hooks.js";
import { IconBell, IconClose } from "../icons.js";

/** Alert kinds reuse the status colour tokens so they read like the dashboard. */
const KIND_TONE: Record<AlertKind, string> = {
  approval_required: "st-approval_required",
  waiting_for_input: "st-waiting_for_input",
  failed: "st-failed",
  completed: "st-completed",
  host_disconnected: "st-disconnected",
  host_reconnected: "st-running",
};

export function AlertsPage() {
  const alerts = useAlerts();
  const store = useAlertStore();
  const now = useNow(30_000);
  const sessions = useSessionViews();
  const hosts = useHosts();
  const [confirmClear, setConfirmClear] = useState(false);

  // Names come from live data; stored alerts hold identifiers only.
  const sessionName = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title ?? s.project_label ?? "Untitled session"])), [sessions.data]);
  const hostName = useMemo(() => new Map((hosts.data ?? []).map((h) => [h.id, h.name])), [hosts.data]);

  const unread = unreadCount(alerts);

  const describe = (a: StoredAlert) => {
    if (a.sessionId) return sessionName.get(a.sessionId) ?? "A session that is no longer listed";
    return hostName.get(a.hostId) ?? "A host that is no longer listed";
  };

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
            {alerts.map((a) => (
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
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
