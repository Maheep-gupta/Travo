import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { DEFAULT_NOTIFICATION_PREFS, MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import type { NotificationPrefs } from "@mc/contracts";
import { forgetAlerts, useAlertStore } from "../alerts-context.js";
import { useApi, useApiContext } from "../api-context.js";
import { ErrorState, Notice, PageHeader, Spinner } from "../components.js";
import { userKey, useUserId } from "../hooks.js";
import { IconCheck } from "../icons.js";
import { webStorage } from "../platform.js";
import { SystemNotificationsCard } from "../system-notifications-card.js";
import {
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  applyThemePreference,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  subscribeSystemTheme,
  systemPrefersLight,
  type ThemePreference,
} from "../theme.js";
import { prefsEqual } from "../view-model.js";

const LABELS: Record<keyof NotificationPrefs, { title: string; hint: string }> = {
  on_approval_required: { title: "Needs approval", hint: "A permission prompt is waiting" },
  on_waiting_for_input: { title: "Waiting for you", hint: "Claude finished its turn" },
  on_failed: { title: "Failed", hint: "The session reported an error" },
  on_completed: { title: "Completed", hint: "The session reported it is done" },
  on_host_disconnected: { title: "Host disconnected", hint: "A laptop stopped reporting" },
  on_host_reconnected: { title: "Host reconnected", hint: "A laptop is reporting again" },
};

export function SettingsPage() {
  const api = useApi();
  const { choice, setChoice } = useApiContext();
  const alertStore = useAlertStore();
  const queryClient = useQueryClient();
  const prefsKey = userKey(api, useUserId(), "prefs");
  const prefsQuery = useQuery({ queryKey: prefsKey, queryFn: () => api.getNotificationPrefs() });
  const schema = useQuery({ queryKey: ["schema", api.kind], queryFn: () => api.getSchemaVersion(), staleTime: Infinity });

  // `draft` holds unsaved edits; null means "showing what is saved".
  const saved = prefsQuery.data ?? DEFAULT_NOTIFICATION_PREFS;
  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const prefs = draft ?? saved;
  const dirty = draft !== null && !prefsEqual(draft, saved);

  const save = useMutation({
    mutationFn: (p: NotificationPrefs) => api.saveNotificationPrefs(p),
    onSuccess: (_data, p) => {
      queryClient.setQueryData(prefsKey, p);
      setDraft(null);
      setJustSaved(true);
    },
  });

  function toggle(k: keyof NotificationPrefs, value: boolean) {
    setDraft({ ...prefs, [k]: value });
    setJustSaved(false);
    save.reset();
  }

  const projectHost = choice?.kind === "supabase" ? hostOf(choice.config.url) : null;

  return (
    <main className="page medium">
      <PageHeader eyebrow="Settings" title="Preferences & connection" />

      <div className="settings-grid">
        <section className="card" aria-labelledby="h-conn">
          <div className="card-title">
            <h2 id="h-conn">Connection</h2>
            <span className={`env-pill static ${api.kind === "demo" ? "demo" : "live"}`}>
              <span className="dot" aria-hidden="true" />
              {api.kind === "demo" ? "Demo data" : "Supabase"}
            </span>
          </div>
          <div className="kv">
            <span>Backend</span>
            <span>{api.kind === "demo" ? "Demo, in this browser only" : "Your Supabase project"}</span>
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
          <div className="kv">
            <span>Replies & approvals</span>
            <span>Off in this release</span>
          </div>
          {api.kind === "demo" && (
            <div style={{ marginTop: "var(--sp-3)" }}>
              <Notice>Everything you see is simulated. Connect a Supabase project to see real data once the security checks are complete.</Notice>
            </div>
          )}
          <div className="row" style={{ marginTop: "var(--sp-4)" }}>
            {api.kind === "supabase" && (
              <button type="button" className="btn" onClick={() => void api.signOut()}>
                Sign out
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

        <section className="card" aria-labelledby="h-notif">
          <div className="card-title">
            <h2 id="h-notif">Alerts</h2>
          </div>
          <p className="card-sub">
            Choose which events create an alert. They appear in <Link to="/alerts">Alerts</Link> and, if you turn them on, as system notifications on
            this device, but only while Tavro is open.
          </p>
          {prefsQuery.isLoading ? (
            <Spinner />
          ) : prefsQuery.error ? (
            <ErrorState error={prefsQuery.error} onRetry={() => void prefsQuery.refetch()} />
          ) : (
            <form
              style={{ marginTop: "var(--sp-3)" }}
              aria-labelledby="h-notif"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty && !save.isPending) save.mutate(prefs);
              }}
            >
              {(Object.keys(LABELS) as (keyof NotificationPrefs)[]).map((k) => (
                <label key={k} className="switch">
                  <span className="label">
                    <span id={`sw-${k}`}>{LABELS[k].title}</span>
                    <small id={`sw-${k}-hint`}>{LABELS[k].hint}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-labelledby={`sw-${k}`}
                    aria-describedby={`sw-${k}-hint`}
                    checked={prefs[k]}
                    disabled={save.isPending}
                    onChange={(e) => toggle(k, e.target.checked)}
                  />
                </label>
              ))}
              <div className="row" style={{ marginTop: "var(--sp-4)" }}>
                <button type="submit" className="btn primary" disabled={!dirty || save.isPending}>
                  {save.isPending ? "Saving…" : "Save preferences"}
                </button>
                {dirty && !save.isPending && (
                  <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                    Discard changes
                  </button>
                )}
                <span role="status" aria-live="polite">
                  {justSaved && !dirty && (
                    <span className="inline-ok">
                      <IconCheck /> Saved
                    </span>
                  )}
                  {dirty && !save.isPending && <span className="muted">Unsaved changes</span>}
                </span>
              </div>
              {save.error && <ErrorState error={save.error} />}
            </form>
          )}
        </section>

        <SystemNotificationsCard />

        <AppearanceCard />
      </div>
    </main>
  );
}

const THEME_LABELS: Record<ThemePreference, string> = { system: "System", dark: "Dark", light: "Light" };

// Same row rhythm as `.switch`, which cannot be reused here: it restyles its input as a toggle.
const themeRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-4)",
  minHeight: 52,
  padding: "var(--sp-2) 0",
  cursor: "pointer",
};
const themeRadio: CSSProperties = { flex: "none", width: 20, height: 20, margin: 0, accentColor: "var(--accent)", cursor: "pointer" };

/** Per-device theme. System follows the OS and shows what it currently resolves to. */
export function AppearanceCard() {
  const name = useId();
  const [pref, setPref] = useState<ThemePreference>(() => loadThemePreference(webStorage));
  const systemIsLight = useSyncExternalStore(subscribeSystemTheme, () => systemPrefersLight());
  const systemLabel = THEME_LABELS[resolveTheme("system", systemIsLight)];

  // main.tsx applies a change made in another tab; keep this control in step with it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY || e.key === null) setPref(parseThemePreference(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function choose(next: ThemePreference) {
    setPref(next);
    saveThemePreference(webStorage, next);
    applyThemePreference(next, document);
  }

  const hints: Record<ThemePreference, string> = {
    system: `Match this device, currently ${systemLabel}`,
    dark: "Always dark",
    light: "Always light",
  };

  return (
    <section className="card" aria-labelledby="h-appearance">
      <div className="card-title">
        <h2 id="h-appearance">Appearance</h2>
      </div>
      <p className="card-sub" id="appearance-sub">
        Saved on this device only.
      </p>
      <fieldset aria-describedby="appearance-sub" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <legend className="sr-only">Theme</legend>
        {THEME_PREFERENCES.map((p, i) => (
          <label key={p} style={{ ...themeRow, borderTop: i === 0 ? 0 : "1px solid var(--line)" }}>
            <span style={{ display: "grid", gap: 2 }}>
              <span id={`${name}-${p}`}>{THEME_LABELS[p]}</span>
              <small id={`${name}-${p}-hint`} style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
                {hints[p]}
              </small>
            </span>
            <input
              type="radio"
              name={name}
              value={p}
              checked={pref === p}
              aria-labelledby={`${name}-${p}`}
              aria-describedby={`${name}-${p}-hint`}
              onChange={() => choose(p)}
              style={themeRadio}
            />
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
