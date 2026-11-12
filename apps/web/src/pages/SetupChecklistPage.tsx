import { useEffect, useState } from "react";
import { Link } from "react-router";
import { setupChecklist, setupSummary, syncWithRefreshes, type SetupAction, type SetupStep } from "@mc/domain";
import { useApi } from "../api-context.js";
import { Notice, PageHeader } from "../components.js";
import { useConnection, useHosts, useSessionViews, useStatusClock } from "../hooks.js";
import { SetupStepList } from "../setup-steps.js";
import { systemNotificationState, type SystemNotificationState } from "../system-notifications.js";

/** This device's notification permission, re-read when the user comes back (it can change in browser settings). */
function useNotificationState(): SystemNotificationState {
  const [state, setState] = useState<SystemNotificationState>(() => systemNotificationState());
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setState(systemNotificationState());
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return state;
}

/** Where each action leads in the web app. Change backend lives in Settings (Account). */
function actionPath(action: SetupAction): string | null {
  switch (action.kind) {
    case "choose_backend":
    case "notifications":
      return "/settings";
    case "hosts":
      return "/hosts";
    case "host":
      return `/hosts/${action.hostId}`;
    case "sessions":
      return "/";
    case "sign_in":
    case "retry":
      return null;
  }
}

/**
 * Spec 11.2 guided setup, for the signed-in app. Everything is derived from the
 * host and session lists already on hand plus this device's notification
 * permission; nothing new is stored. Spec 11.3: a step is only done with
 * evidence, and data that is loading, failed or not current says so.
 */
export function SetupChecklistPage() {
  const api = useApi();
  const now = useStatusClock();
  const hosts = useHosts();
  const views = useSessionViews();
  // Heartbeat and source health are judged from the host list alone, as on Hosts.
  const sync = syncWithRefreshes(useConnection(now).kind, [views.hosts]);
  const notifications = useNotificationState();

  const checklist = setupChecklist({
    backend: api.kind,
    // This page is only reachable signed in.
    signedIn: true,
    hosts: { state: views.hosts, data: hosts.data ?? null },
    // The session list is only built once the host list has settled; until then it is still loading.
    sessions: views.data
      ? { state: views.sessions, count: views.data.length, dropped: views.dropped }
      : { state: views.sessions === "failed" ? "failed" : "loading", count: null, dropped: 0 },
    sync,
    notifications,
    now,
  });

  const renderAction = (step: SetupStep) => {
    if (!step.action || !step.actionLabel) return null;
    if (step.action.kind === "retry") {
      return (
        <button type="button" className="btn small" onClick={views.refetch}>
          {step.actionLabel}
        </button>
      );
    }
    const to = actionPath(step.action);
    return to ? (
      <Link to={to} className={`btn small${step.state === "current" ? " primary" : ""}`}>
        {step.actionLabel}
      </Link>
    ) : null;
  };

  return (
    <main className="page medium">
      <PageHeader eyebrow="Setup" title="Setup checklist">
        Each step is checked against what Tavro can see right now. Nothing is marked done without evidence.
      </PageHeader>

      {checklist.demo && (
        <div className="section">
          <Notice>
            Demo data: the hosts and sessions below are simulated in this browser. The checklist shows how setup works; connect your own Supabase
            project from Settings to set up a real laptop.
          </Notice>
        </div>
      )}

      <section className="card section" aria-labelledby="h-setup">
        <div className="card-title">
          <h2 id="h-setup">Steps</h2>
        </div>
        <p className="setup-progress" aria-live="polite">
          {setupSummary(checklist)}
        </p>
        <SetupStepList steps={checklist.steps} renderAction={renderAction} />
      </section>
    </main>
  );
}
