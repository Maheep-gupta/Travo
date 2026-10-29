import { useRef, useState, type FormEvent } from "react";
import { ConnectionConfig } from "@mc/api-client/connection";
import { useApiContext } from "../api-context.js";
import { fieldErrors, firstInvalidField, type FieldErrors } from "../form-errors.js";
import { BrandMark } from "../icons.js";

const FIELDS = ["url", "publishableKey"] as const;
type Field = (typeof FIELDS)[number];

export function SetupPage() {
  const { setChoice } = useApiContext();
  const [url, setUrl] = useState("http://127.0.0.1:54321");
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const inputs = { url: useRef<HTMLInputElement>(null), publishableKey: useRef<HTMLInputElement>(null) };

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

        <section className="card choice" aria-labelledby="h-demo">
          <h2 id="h-demo">Explore with demo data</h2>
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
            <span>Project URL</span>
            <input
              ref={inputs.url}
              className="input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
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
            <span>Publishable key</span>
            <input
              ref={inputs.publishableKey}
              className="input mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
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
        <p className="footnote">Replies and approvals are not available in this release.</p>
      </div>
    </main>
  );
}
