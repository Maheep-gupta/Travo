import { useRef, useState, type FormEvent } from "react";
import { ConnectionConfig } from "@mc/api-client/connection";
import { setupChecklist } from "@mc/domain";
import { useApiContext } from "../api-context.js";
import { fieldErrors, firstInvalidField, type FieldErrors } from "../form-errors.js";
import { BrandMark } from "../icons.js";
import { SetupStepList } from "../setup-steps.js";
import { systemNotificationState } from "../system-notifications.js";

const FIELDS = ["url", "publishableKey"] as const;
type Field = (typeof FIELDS)[number];

/**
 * The URL field's starting value. Dev builds suggest the local Supabase stack;
 * a production build starts empty, so a deployed app never suggests its
 * visitor's own loopback address as the backend (release review S9).
 */
export function defaultProjectUrl(dev: boolean = import.meta.env.DEV): string {
  return dev ? "http://127.0.0.1:54321" : "";
}

export function SetupPage() {
  const { setChoice } = useApiContext();
  const [url, setUrl] = useState(defaultProjectUrl);
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const demoHeading = useRef<HTMLHeadingElement>(null);
  const inputs = { url: useRef<HTMLInputElement>(null), publishableKey: useRef<HTMLInputElement>(null) };
  // Nothing is chosen yet, so there are no hosts or sessions to look at.
  const [preview] = useState(() =>
    setupChecklist({
      backend: "none",
      signedIn: false,
      hosts: { state: "loading", data: null },
      sessions: { state: "loading", count: null, dropped: 0 },
      sync: "current",
      notifications: systemNotificationState(),
      now: new Date(),
    }),
  );

  function connect(e: FormEvent) {
    e.preventDefault();
    const parsed = ConnectionConfig.safeParse({ url, publishableKey: key });
    if (!parsed.success) {
      const next = fieldErrors(parsed.error.issues, FIELDS);
      if (!Object.keys(next).length) next.form = "Invalid settings.";
      setErrors(next);
      const first = firstInvalidField(next, FIELDS);
      if (first) inputs[first].current?.focus();
      return;
    }
    setErrors({});
    setChoice({ kind: "supabase", config: parsed.data });
  }

  // Each input lists its hint (if any) and its error (if any) as descriptions.
  const describedBy = (field: Field, hint?: string) => [hint, errors[field] ? `${field}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <main className="auth">
      <div className="auth-inner">
        <div className="auth-brand">
          <BrandMark />
          <span className="eyebrow">Tavro</span>
        </div>
        <div className="stack">
          <h1>Your AI sessions. In sync.</h1>
          <p className="muted">See which sessions are working, which need you, and which hosts are offline, from any screen.</p>
        </div>

        {/* Spec 11.1: what Tavro does, collects and can't do, before anything is connected. */}
        <section className="card onboarding" aria-labelledby="h-about">
          <h2 id="h-about">Before you start</h2>
          <dl>
            <div>
              <dt>What it does</dt>
              <dd>A small connector on your computer reports each session's status. Tavro shows it here and alerts you when a session needs you.</dd>
            </div>
            <div>
              <dt>What it stores, and where</dt>
              <dd>
                A Supabase project you own holds each session's title, project label, provider, status and reason, last event summary and times, its
                status history, each host's name, platform, connector version and heartbeat and source-health times, and which alert types you want. Alert
                history and this device's preferences stay in this browser. Tavro has no servers of its own.
              </dd>
            </div>
            <div>
              <dt>What it can't do</dt>
              <dd>
                No replies, resume or remote approvals. Notifications never contain transcript text, and they only arrive while Tavro is open. Claude Code
                support is not enabled yet.
              </dd>
            </div>
            <div>
              <dt>Demo mode</dt>
              <dd>Simulated sessions, marked Demo, generated in this browser. Nothing is sent anywhere.</dd>
            </div>
          </dl>
        </section>

        <section className="card choice" aria-labelledby="h-demo">
          <h2 id="h-demo" ref={demoHeading} tabIndex={-1}>Explore with demo data</h2>
          <p className="muted">Runs entirely in this browser with simulated sessions. No account, no network calls, no real Claude data.</p>
          <button type="button" className="btn primary block" onClick={() => setChoice({ kind: "demo" })}>
            Open demo
          </button>
        </section>

        <div className="divider">or</div>

        <form className="card" onSubmit={connect} noValidate aria-labelledby="h-connect">
          <h2 id="h-connect">Connect your Supabase project</h2>
          <p className="card-sub" style={{ marginTop: "var(--sp-1)" }}>
            Your data stays in a project you control.
          </p>
          <label className="field">
            <span id="url-label">Project URL</span>
            <input
              ref={inputs.url}
              aria-labelledby="url-label"
              className="input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://<project-ref>.supabase.co"
              aria-invalid={errors.url ? true : undefined}
              aria-describedby={describedBy("url")}
            />
            {errors.url && (
              <span className="field-error" id="url-error">
                {errors.url}
              </span>
            )}
          </label>
          <label className="field">
            <span id="key-label">Publishable key</span>
            <input
              ref={inputs.publishableKey}
              aria-labelledby="key-label"
              className="input mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="sb_publishable_…"
              aria-invalid={errors.publishableKey ? true : undefined}
              aria-describedby={describedBy("publishableKey", "key-hint")}
            />
            {errors.publishableKey && (
              <span className="field-error" id="publishableKey-error">
                {errors.publishableKey}
              </span>
            )}
            <span className="hint" id="key-hint">
              Never paste a secret or service-role key. This app rejects them.
            </span>
          </label>
          {errors.form && (
            <p className="notice error" role="alert" style={{ marginBottom: "var(--sp-4)" }}>
              {errors.form}
            </p>
          )}
          <button type="submit" className="btn block">
            Connect
          </button>
        </form>

        {/* Spec 11.2: the whole path up front. Only the first step can be done from here; the rest wait on it.
            It follows the two ways in so they stay on the first screen of a phone. */}
        <section className="card" aria-labelledby="h-steps">
          <h2 id="h-steps">Setup steps</h2>
          <p className="card-sub" style={{ marginTop: "var(--sp-1)" }}>
            After you connect, Settings links to this checklist, and each step is checked against what Tavro can actually see.
          </p>
          <SetupStepList
            steps={preview.steps}
            renderAction={(step) =>
              step.action?.kind === "choose_backend" ? (
                <a
                  href="#h-demo"
                  className="btn small primary"
                  onClick={(e) => {
                    // A bare #hash would scroll but leave keyboard focus where it was.
                    e.preventDefault();
                    demoHeading.current?.focus();
                  }}
                >
                  Choose above
                </a>
              ) : null
            }
          />
        </section>
        <p className="footnote">Replies and approvals are not available in this release.</p>
      </div>
    </main>
  );
}
