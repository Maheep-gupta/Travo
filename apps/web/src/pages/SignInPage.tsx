import { useState, type FormEvent } from "react";
import type { AuthUser } from "@mc/api-client/demo";
import { useApi, useApiContext } from "../api-context.js";
import { BrandMark } from "../icons.js";

export function SignInPage({ onSignedIn }: { onSignedIn: (u: AuthUser | null) => void }) {
  const api = useApi();
  const { setChoice } = useApiContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.signIn(email.trim(), password);
      onSignedIn(await api.getUser());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-inner">
        <div className="auth-brand">
          <BrandMark />
          <span className="eyebrow">Tavro</span>
        </div>
        <h1>Sign in</h1>
        <form className="card" onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="notice error" role="alert" style={{ marginBottom: "var(--sp-4)" }}>
              {error}
            </p>
          )}
          <button type="submit" className="btn primary block" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <button type="button" className="btn ghost" onClick={() => setChoice(null)}>
          Change backend
        </button>
      </div>
    </main>
  );
}
