// Settings sections that report rather than configure (spec 12): Account,
// Privacy and data, Integrations, Application. Every control here does what
// it says; anything Tavro can't change yet is shown as information instead.
import { useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import { MAX_STORED_ALERTS } from "@mc/domain";
import { forgetAlerts, useAlertStore } from "./alerts-context.js";
import { useApi, useApiContext } from "./api-context.js";
import { APP_VERSION, BUILD_MODE, installState, type InstallState } from "./app-info.js";
import { Notice } from "./components.js";
import { SignOutReportContext, useUserId } from "./hooks.js";
import { IconCheck } from "./icons.js";
import { clearLocalTavroData } from "./local-data.js";
import { webStorage } from "./platform.js";
import { SESSION_NAMES_OPTION_APPROVED } from "./system-notifications.js";
import { applyThemePreference } from "./theme.js";

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

/** The signed-in account's email, read from the stored session (no network call). */
function useSignedInEmail(): { loading: boolean; email: string | null } {
  const api = useApi();
  const userId = useUserId();
  const [state, setState] = useState<{ loading: boolean; email: string | null }>({ loading: true, email: null });
  useEffect(() => {
    let alive = true;
    api.getUser().then(
      (u) => alive && setState({ loading: false, email: u && u.id === userId ? u.email : null }),
      () => alive && setState({ loading: false, email: null }),
    );
    return () => {
      alive = false;
    };
  }, [api, userId]);
  return state;
}

export function AccountCard() {
  const api = useApi();
  const { choice, setChoice } = useApiContext();
  const alertStore = useAlertStore();
  const reportSignOut = useContext(SignOutReportContext);
  const schema = useQuery({ queryKey: ["schema", api.kind], queryFn: () => api.getSchemaVersion(), staleTime: Infinity });
  const account = useSignedInEmail();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const isDemo = api.kind === "demo";
  const projectHost = choice?.kind === "supabase" ? hostOf(choice.config.url) : null;

  function signOut() {
    setSigningOut(true);
    setSignOutFailed(false);
    // The session always ends here, and the auth gate returns to sign-in,
    // which unmounts this card; it says there if the server wasn't told.
    // Signing out on purpose also forgets this device's alert history (an
    // expired sign-in keeps it); other tabs see the cleared list. A rejection
    // means the session couldn't even be removed here.
    api.signOut().then(
      (result) => {
        forgetAlerts(alertStore);
        setSigningOut(false);
        reportSignOut(result);
      },
      () => {
        setSigningOut(false);
        setSignOutFailed(true);
      },
    );
  }

  return (
    <section className="card" aria-labelledby="h-account">
      <div className="card-title">
        <h2 id="h-account">Account</h2>
        <span className={`env-pill static ${isDemo ? "demo" : "live"}`}>
          <span className="dot" aria-hidden="true" />
          {isDemo ? "Demo data" : "Supabase"}
        </span>
      </div>
      <div className="kv">
        <span>Signed in as</span>
        <span>{isDemo ? "Demo user, no sign-in needed" : account.loading ? "Loading…" : (account.email ?? "Email not available")}</span>
      </div>
      <div className="kv">
        <span>Backend</span>
        <span>{isDemo ? "Demo, in this browser only" : "Your own Supabase project"}</span>
      </div>
      {projectHost && (
        <div className="kv">
          <span>Project</span>
          <span className="mono">{projectHost}</span>
        </div>
      )}
      <div className="kv">
        <span>Schema</span>
        <span className="mono">{schema.data ? `v${schema.data} (app supports ≤ v${MAX_SCHEMA_VERSION})` : "—"}</span>
      </div>
      {isDemo && (
        <div className="settings-note">
          <Notice>Everything you see is simulated. Connect a Supabase project to see real data once the security checks are complete.</Notice>
        </div>
      )}
      {signOutFailed && (
        <div className="settings-note">
          <Notice tone="error">
            <p>Couldn't sign out on this device. Try again.</p>
          </Notice>
        </div>
      )}
      <div className="row settings-actions">
        {!isDemo && (
          <button type="button" className="btn" disabled={signingOut} onClick={signOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            forgetAlerts(alertStore);
            setChoice(null);
          }}
        >
          Change backend
        </button>
      </div>
    </section>
  );
}

/** What Tavro stores and where (spec 10.2), with a confirmed way to clear this device's part. */
export function PrivacyCard({ onCleared }: { onCleared: () => void }) {
  const api = useApi();
  const { choice } = useApiContext();
  const alertStore = useAlertStore();
  const userId = useUserId();
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const isDemo = api.kind === "demo";
  const projectHost = choice?.kind === "supabase" ? hostOf(choice.config.url) : null;

  // The button that opened the confirmation disappears, so keep keyboard focus on the dialog's safe choice and return it afterwards.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (restoreFocus.current) clearRef.current?.focus();
    restoreFocus.current = false;
  }, [confirming]);

  function close() {
    restoreFocus.current = true;
    setConfirming(false);
  }

  function clearNow() {
    clearLocalTavroData(webStorage, alertStore, api.kind, userId);
    applyThemePreference("system", document);
    setCleared(true);
    onCleared();
    close();
  }

  return (
    <section className="card" aria-labelledby="h-privacy">
      <div className="card-title">
        <h2 id="h-privacy">Privacy & data</h2>
      </div>
      <p className="card-sub">Tavro has no servers of its own and no analytics. This app only talks to the backend you chose.</p>

      <h3 className="settings-h3">Where your sessions live</h3>
      <ul className="settings-list">
        {isDemo ? (
          <li>Demo sessions, hosts and alert-type choices are generated in this tab's memory. Nothing is sent anywhere, and they reset when you reload.</li>
        ) : (
          <>
            <li>
              This is stored in your own Supabase project{projectHost ? <> (<span className="mono">{projectHost}</span>)</> : null}, where retention is up
              to you:
              <ul>
                <li>
                  Sessions: title, project label, provider and its session id, status and status reason, last event summary, capabilities, and start, end,
                  activity and update times.
                </li>
                <li>Status history: each change's status, a short summary and when it happened.</li>
                <li>
                  Hosts: name, platform, connector version, the organisation's remote-control policy, heartbeat and session-source health times, and when it
                  was paired or revoked. Pairing codes are kept only as hashes.
                </li>
                <li>Which alert types you want.</li>
              </ul>
            </li>
            <li>Row-level security limits every row to its owner. Its automated database tests haven't run yet.</li>
          </>
        )}
        <li>Transcript text is never sent to a remote project. A connector only writes it to a database on the same machine, and only if you turn that on.</li>
      </ul>

      <h3 className="settings-h3">Stored in this browser</h3>
      <ul className="settings-list">
        <li>Alert history: up to {MAX_STORED_ALERTS} recent alerts per account, as ids, kinds, times and read state. No names or session text.</li>
        <li>
          Preferences for this device: appearance and the system-notification switch
          {SESSION_NAMES_OPTION_APPROVED && <>, and for this account whether notifications may include names</>}. Alert types are saved with your data
          above, not here.
        </li>
        {isDemo ? (
          <li>That you chose demo mode.</li>
        ) : (
          <li>Your project URL and publishable key, and your sign-in session. Sign out removes the sign-in; Change backend removes the project details.</li>
        )}
      </ul>

      <h3 className="settings-h3">Notifications</h3>
      <ul className="settings-list">
        <li>
          {SESSION_NAMES_OPTION_APPROVED
            ? "System notifications say what kind of event happened. They include session and host names only if you turn that on for this account on this device, and never any transcript text."
            : "System notifications say what kind of event happened, without session or host names and without any transcript text."}
        </li>
      </ul>

      <div className="settings-actions">
        {confirming ? (
          <div className="settings-confirm" role="group" aria-labelledby="clear-confirm-text">
            <p id="clear-confirm-text">
              Clear this account's alert history on this device and reset this device's preferences (appearance, system notifications)? Other accounts'
              data on this device, your Supabase data, sign-in and connection are not affected. This can't be undone.
            </p>
            <div className="row">
              <button type="button" className="btn danger" onClick={clearNow}>
                Clear data
              </button>
              <button ref={cancelRef} type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={clearRef}
            type="button"
            className="btn danger"
            onClick={() => {
              setCleared(false);
              setConfirming(true);
            }}
          >
            Clear this account's data on this device…
          </button>
        )}
        <span role="status" aria-live="polite">
          {cleared && !confirming && (
            <span className="inline-ok">
              <IconCheck /> Cleared from this device
            </span>
          )}
        </span>
      </div>
    </section>
  );
}

export function IntegrationsCard() {
  const isDemo = useApi().kind === "demo";
  return (
    <section className="card" aria-labelledby="h-integrations">
      <div className="card-title">
        <h2 id="h-integrations">Integrations</h2>
      </div>
      <div className="integration">
        <div className="integration-head">
          <h3 className="settings-h3">Claude Code</h3>
          <span className="tag">Not enabled yet</span>
        </div>
        <p className="muted">
          The real Claude Code connection stays off until Tavro's database security tests have run and passed.{" "}
          {isDemo ? "Until then, sessions come from the demo simulator in this browser." : "Until then, connectors report simulated sessions from their mock provider."}
        </p>
      </div>
      <div className="kv">
        <span>Active source</span>
        <span>{isDemo ? "Demo simulator" : "Connector mock provider"}</span>
      </div>
      <div className="kv">
        <span>Capabilities</span>
        <span>Status and activity, read-only</span>
      </div>
      <div className="kv">
        <span>Replies & approvals</span>
        <span>Off in this release</span>
      </div>
    </section>
  );
}

const INSTALL_LABEL: Record<InstallState, string> = {
  installed: "Installed app",
  browser: "Browser tab",
  unknown: "Unknown",
};

export function ApplicationCard() {
  const [install] = useState(() => installState());
  return (
    <section className="card" aria-labelledby="h-app">
      <div className="card-title">
        <h2 id="h-app">Application</h2>
      </div>
      <div className="kv">
        <span>Version</span>
        <span className="mono">{APP_VERSION}</span>
      </div>
      <div className="kv">
        <span>Build</span>
        <span className="mono">{BUILD_MODE}</span>
      </div>
      <div className="kv">
        <span>Running as</span>
        <span>{INSTALL_LABEL[install]}</span>
      </div>

      <h3 className="settings-h3">Install Tavro</h3>
      <ul className="settings-list">
        <li>
          <strong>Android (Chrome):</strong> open the ⋮ menu and choose Install app or Add to Home screen.
        </li>
        <li>
          <strong>iPhone and iPad (Safari):</strong> tap Share, then Add to Home Screen. System notifications on iOS only work from the Home Screen app.
        </li>
        <li>
          <strong>Desktop (Chrome or Edge):</strong> use the install icon in the address bar, or the browser menu's Install Tavro.
        </li>
      </ul>
      <p className="muted settings-small">Installed or not, notifications only arrive while Tavro is open.</p>
    </section>
  );
}
