import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PairingTicket } from "@mc/contracts";
import { hostConnectivity, relativeTime } from "@mc/domain";
import { useApi } from "../api-context.js";
import { ConnectivityBadge, DemoTag, EmptyState, ErrorState, Notice, PageHeader, SessionListSkeleton } from "../components.js";
import { useHosts, useNow } from "../hooks.js";
import { IconCopy, IconHost } from "../icons.js";

export function HostsPage() {
  const api = useApi();
  const now = useNow();
  const hosts = useHosts();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  const pair = useMutation({
    mutationFn: (hostName: string) => api.createHostPairing(hostName),
    onSuccess: (t) => {
      setTicket(t);
      setCopy("idle");
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (hostId: string) => api.revokeHost(hostId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["hosts"] }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() && !pair.isPending) pair.mutate(name.trim());
  }

  function confirmRevoke(hostId: string, hostName: string) {
    if (window.confirm(`Revoke "${hostName}"? Its connector will immediately lose access. This cannot be undone; you would need to pair it again.`)) {
      revoke.mutate(hostId);
    }
  }

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
    } catch {
      // Clipboard can be blocked (permissions, insecure context): say so.
      setCopy("failed");
    }
  }

  const online = (hosts.data ?? []).filter((h) => hostConnectivity(h, now) === "online").length;

  return (
    <main className="page">
      <PageHeader eyebrow="Hosts" title="Your machines">
        Laptops running the Tavro connector. It only connects outward and can only report its own sessions.
      </PageHeader>

      {hosts.isLoading ? (
        <SessionListSkeleton count={2} />
      ) : hosts.error ? (
        <ErrorState error={hosts.error} onRetry={() => void hosts.refetch()} />
      ) : hosts.data?.length ? (
        <section aria-labelledby="h-hosts">
          <div className="section-head">
            <h2 id="h-hosts">Paired hosts</h2>
            <span className="count">
              {online} of {hosts.data.length} online
            </span>
          </div>
          <ul className="host-list">
            {hosts.data.map((h) => {
              const c = hostConnectivity(h, now);
              return (
                <li key={h.id} className={`card host-card ${h.revoked_at ? "revoked" : ""}`}>
                  <div className="head">
                    <IconHost />
                    <h3>{h.name}</h3>
                    {api.kind === "demo" && <DemoTag />}
                    <ConnectivityBadge connectivity={c} />
                  </div>
                  <dl className="facts">
                    <div>
                      <dt>Last seen</dt>
                      <dd title={h.last_seen_at ? new Date(h.last_seen_at).toLocaleString() : undefined}>{relativeTime(h.last_seen_at, now)}</dd>
                    </div>
                    <div>
                      <dt>Platform</dt>
                      <dd className="mono">
                        {h.platform ?? "unknown"} · connector {h.connector_version ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Remote control</dt>
                      <dd>
                        {h.remote_control_allowed === null
                          ? "Policy unknown (treated as off)"
                          : h.remote_control_allowed
                            ? "Allowed by organisation"
                            : "Disabled by organisation"}
                      </dd>
                    </div>
                  </dl>
                  {revoke.isError && revoke.variables === h.id && (
                    <ErrorState error={revoke.error} onRetry={() => confirmRevoke(h.id, h.name)} />
                  )}
                  {h.revoked_at ? (
                    <p className="muted">Revoked {relativeTime(h.revoked_at, now)}. Pair again to reconnect.</p>
                  ) : (
                    <div>
                      <button
                        type="button"
                        className="btn danger small"
                        disabled={revoke.isPending}
                        aria-label={`Revoke access for ${h.name}`}
                        onClick={() => confirmRevoke(h.id, h.name)}
                      >
                        {revoke.isPending && revoke.variables === h.id ? "Revoking…" : "Revoke access"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <EmptyState title="No hosts paired yet" icon={<IconHost />}>
          <p>Pair the laptop where Claude Code runs to start seeing its sessions here.</p>
        </EmptyState>
      )}

      <section className="section" aria-labelledby="h-pair">
        <div className="section-head">
          <h2 id="h-pair">Pair a new host</h2>
        </div>
        <div className="card">
          {api.kind === "demo" ? (
            <Notice>
              Pairing needs your own Supabase project. Demo mode only shows simulated hosts, so there is nothing to pair here.
            </Notice>
          ) : (
            <form onSubmit={submit}>
              <p className="card-sub" style={{ marginTop: 0 }}>
                Creates a single-use code valid for 10 minutes. The connector exchanges it for its own limited login.
              </p>
              <label className="field">
                <span>Host name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Work laptop" />
              </label>
              <button type="submit" className="btn primary" disabled={!name.trim() || pair.isPending}>
                {pair.isPending ? "Creating code…" : "Create pairing code"}
              </button>
            </form>
          )}
          {pair.error && <ErrorState error={pair.error} />}
          {ticket && (
            <div className="ticket" role="status">
              <span className="eyebrow">Pairing code</span>
              <div className="code">{ticket.code}</div>
              <span className="muted">On the laptop, in the Tavro project folder, run:</span>
              <pre>npm run connector -- pair {ticket.code}</pre>
              <div className="row">
                <button type="button" className="btn small" onClick={() => void copyCommand(`npm run connector -- pair ${ticket.code}`)}>
                  <IconCopy />
                  {copy === "copied" ? "Copied" : "Copy command"}
                </button>
                <span className="muted">Expires {new Date(ticket.expires_at).toLocaleTimeString()} · shown once</span>
              </div>
              <span role="status" aria-live="polite" className={copy === "failed" ? "field-error" : "sr-only"}>
                {copy === "copied" ? "Command copied to clipboard." : copy === "failed" ? "Couldn't copy automatically. Select the command above and copy it manually." : ""}
              </span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
