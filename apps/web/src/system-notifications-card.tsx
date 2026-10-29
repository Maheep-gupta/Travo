import { useEffect, useState } from "react";
import { Notice } from "./components.js";
import { webStorage } from "./platform.js";
import {
  loadSystemNotificationsEnabled,
  requestSystemNotifications,
  saveSystemNotificationsEnabled,
  showSystemNotification,
  systemNotificationsFailed,
  systemNotificationState,
  type SystemNotificationState,
} from "./system-notifications.js";

/**
 * Per-device opt-in for foreground system notifications. Every browser state
 * is explained; permission is only requested from the button below.
 */
export function SystemNotificationsCard() {
  const [state, setState] = useState<SystemNotificationState>(() => systemNotificationState());
  const [enabled, setEnabled] = useState(() => loadSystemNotificationsEnabled(webStorage));
  const [requesting, setRequesting] = useState(false);
  const [testResult, setTestResult] = useState<"sent" | "failed" | null>(null);
  const [backgroundFailed, setBackgroundFailed] = useState(() => systemNotificationsFailed());
  const failed = testResult === "failed" || backgroundFailed;

  // Permission can change in browser settings, and a background notification can
  // fail while Settings is open; re-read both whenever the user comes back.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      setState(systemNotificationState());
      setBackgroundFailed(systemNotificationsFailed());
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  function setOn(on: boolean) {
    saveSystemNotificationsEnabled(webStorage, on);
    setEnabled(on);
    setTestResult(null);
  }

  async function turnOn() {
    setRequesting(true);
    const next = await requestSystemNotifications();
    setRequesting(false);
    setState(next);
    if (next === "granted") setOn(true);
  }

  function sendTest() {
    const ok = showSystemNotification({ id: `test:${Date.now()}`, kind: "waiting_for_input", sessionId: null, hostId: "test", at: new Date().toISOString(), isDemo: false }, () => window.focus());
    setTestResult(ok ? "sent" : "failed");
  }

  return (
    <section className="card" aria-labelledby="h-sysnotif">
      <div className="card-title">
        <h2 id="h-sysnotif">System notifications on this device</h2>
      </div>
      <p className="card-sub">
        Shows an operating-system notification when an alert arrives while Tavro is open in a background tab. Notifications say what happened, never
        which session, because they can appear on a lock screen.
      </p>

      {state === "unsupported" && (
        <Notice>
          This browser doesn't offer notifications to web pages here. On iPhone and iPad they only work after adding Tavro to the Home Screen. In-app
          alerts still work.
        </Notice>
      )}

      {state === "denied" && (
        <Notice tone="warn">
          Notifications are blocked for this site. To allow them, open your browser's site settings for Tavro, set Notifications to Allow, then
          reload. Tavro won't ask again on its own.
        </Notice>
      )}

      {state === "default" && (
        <div className="row">
          <button type="button" className="btn primary" onClick={() => void turnOn()} disabled={requesting}>
            {requesting ? "Waiting for your browser…" : "Turn on system notifications"}
          </button>
          <span className="muted">Your browser will ask for permission.</span>
        </div>
      )}

      {state === "granted" && (
        <>
          <label className="switch">
            <span className="label">
              <span id="sw-sys">Notify me on this device</span>
              <small id="sw-sys-hint">Only while Tavro is open. Uses your alert preferences above.</small>
            </span>
            <input type="checkbox" role="switch" aria-labelledby="sw-sys" aria-describedby="sw-sys-hint" checked={enabled} onChange={(e) => setOn(e.target.checked)} />
          </label>
          {enabled && (
            <div className="row" style={{ marginTop: "var(--sp-2)" }}>
              <button type="button" className="btn small" onClick={sendTest}>
                Send a test notification
              </button>
              <span role="status" aria-live="polite" className="muted">
                {testResult === "sent" && "Sent. If nothing appeared, check your system's Focus or Do Not Disturb settings."}
              </span>
            </div>
          )}
        </>
      )}

      {failed && (
        <div style={{ marginTop: "var(--sp-3)" }}>
          <Notice tone="error">
            This browser refused to show a notification. Some browsers, including Chrome on Android, only allow them from an installed background
            service, which Tavro doesn't have yet. In-app alerts still work.
          </Notice>
        </div>
      )}

      <p className="muted" style={{ marginTop: "var(--sp-3)", fontSize: "0.86rem" }}>
        Nothing is delivered when Tavro is closed, and alerts may arrive late if the browser has put the tab to sleep. Background push isn't available
        yet.
      </p>
    </section>
  );
}
