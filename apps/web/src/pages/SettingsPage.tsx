import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_NOTIFICATION_PREFS, MAX_SCHEMA_VERSION } from "@mc/contracts/constants";
import type { NotificationPrefs } from "@mc/contracts";
import { useApi, useApiContext } from "../api-context.js";
import { ErrorState, Notice, PageHeader, Spinner } from "../components.js";
import { IconCheck } from "../icons.js";
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
  const queryClient = useQueryClient();
  const prefsKey = ["prefs", api.kind];
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
            <button type="button" className="btn ghost" onClick={() => setChoice(null)}>
              Change backend
            </button>
          </div>
        </section>

        <section className="card" aria-labelledby="h-notif">
          <div className="card-title">
            <h2 id="h-notif">Notifications</h2>
          </div>
          <Notice tone="warn">
            <strong>Push delivery isn't enabled yet.</strong> Your choices are saved and will apply once push notifications are reviewed and turned on.
            Until then, changes appear live while the app is open.
          </Notice>
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
      </div>
    </main>
  );
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
