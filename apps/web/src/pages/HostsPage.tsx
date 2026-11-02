import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HostRow, PairingTicket } from "@mc/contracts";
import {
  buildHostView,
  hostSourceOk,
  pairingPollInterval,
  pairingStatus,
  relativeTime,
  summariseByHost,
  type HostSessionSummary,
  type PairingStatus,
} from "@mc/domain";
import { useApi } from "../api-context.js";
import { ConnectivityBadge, DemoTag, EmptyState, ErrorState, Notice, PageHeader, SessionListSkeleton } from "../components.js";
import { useConnection, useHosts, useNow, useSessionViews, userKey, useUserId } from "../hooks.js";
import { IconAlert, IconCheck, IconClock, IconCopy, IconHost } from "../icons.js";
import { FreshnessNote } from "./DashboardPage.js";

export function HostsPage() {
  const api = useApi();
  const now = useNow();
  const hosts = useHosts();
  const sessions = useSessionViews();
  const sync = useConnection(now).kind;
  const hostView = (h: HostRow) => buildHostView(h, now, { sync, fetchedAt: hosts.dataUpdatedAt });
  const summaries = useMemo(() => (sessions.data ? summariseByHost(sessions.data) : null), [sessions.data]);
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

  const online = (hosts.data ?? []).filter((h) => hostView(h).connectivity === "online").length;

  return (
    <main className="page">
      <PageHeader eyebrow="Hosts" title="Your machines">
        Laptops running the Tavro connector. It only connects outward and can only report its own sessions.
      </PageHeader>

      {hosts.isLoading ? (
        <SessionListSkeleton count={2} label="Loading hosts…" />
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
              const { connectivity: c, freshness } = hostView(h);
              return (
                <li key={h.id} className={`card host-card ${h.revoked_at ? "revoked" : ""}`}>
                  <div className="head">
                    <IconHost />
                    <h3>
                      <Link to={`/hosts/${h.id}`}>{h.name}</Link>
                    </h3>
                    {api.kind === "demo" && <DemoTag />}
                    <ConnectivityBadge connectivity={c} />
                  </div>
                  {c === "online" && !hostSourceOk(h) && (
                    <p className="host-warning" role="note">
                      <IconAlert /> Can't read its sessions since {relativeTime(h.provider_error_since, now)}. Their status may be out of date until it recovers.
                    </p>
                  )}
                  <dl className="facts">
                    <div>
                      <dt>Last seen</dt>
                      <dd title={h.last_seen_at ? new Date(h.last_seen_at).toLocaleString() : undefined}>{relativeTime(h.last_seen_at, now)}</dd>
                    </div>
                    <div>
                      <dt>Last update</dt>
                      <dd>
                        <FreshnessNote freshness={freshness} now={now} />
                      </dd>
                    </div>
                    <div>
                      <dt>Sessions</dt>
                      <dd>{sessionSummary(summaries, sessions.isLoading, h.id, now)}</dd>
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
              <PairingConfirmation ticket={ticket} />
              {/* Announced by the ticket's own status region; a nested live region would double-announce. */}
              <span className={copy === "failed" ? "field-error" : "sr-only"}>
                {copy === "copied" ? "Command copied to clipboard." : copy === "failed" ? "Couldn't copy automatically. Select the command above and copy it manually." : ""}
              </span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

/** "3 · last active 5m ago". Session counts load separately from hosts, so say when they're unavailable. */
function sessionSummary(summaries: Map<string, HostSessionSummary> | null, loading: boolean, hostId: string, now: Date): string {
  if (!summaries) return loading ? "Loading…" : "Unavailable";
  const s = summaries.get(hostId);
  if (!s) return "None";
  return s.lastActivityAt ? `${s.count} · last active ${relativeTime(s.lastActivityAt, now)}` : String(s.count);
}

const PAIRING_TEXT: Record<PairingStatus, string> = {
  waiting: "Waiting for the connector to connect. Run the command above on the laptop; this page checks automatically.",
  paired: "Code accepted. Waiting for the connector's first heartbeat.",
  connected: "Connected. The connector is reporting.",
  stopped: "The connector connected but has stopped reporting. Check that it is still running on the laptop.",
  expired: "Not connected: the code expired before the connector used it. Create a new code to try again.",
  revoked: "Not connected: this host was revoked. Create a new code to pair again.",
};

/**
 * Spec 11.3: never assume pairing worked. Re-reads the host list (its own
 * observer on the shared hosts query) until the new host has heartbeated,
 * and stops polling once there is an answer or the code is long expired.
 */
function PairingConfirmation({ ticket }: { ticket: PairingTicket }) {
  const api = useApi();
  const userId = useUserId();
  const now = useNow(PAIRING_CLOCK_MS);
  const hosts = useQuery({
    queryKey: userKey(api, userId, "hosts"),
    queryFn: () => api.listHosts(),
    refetchInterval: (query) => pairingPollInterval(pairingStatus(ticket, query.state.data?.find((h) => h.id === ticket.host_id), new Date()), ticket, new Date()),
  });
  const host = hosts.data?.find((h) => h.id === ticket.host_id);
  const status = pairingStatus(ticket, host, now);
  const gaveUp = (status === "waiting" || status === "paired") && pairingPollInterval(status, ticket, now) === false;

  return (
    <div className={`pairing-state ps-${status}`}>
      {status === "connected" ? <IconCheck /> : status === "waiting" || status === "paired" ? <IconClock /> : <IconAlert />}
      <p>
        {gaveUp ? "Still not connected. Check that the connector is running on the laptop, then check again." : PAIRING_TEXT[status]}
        {status === "connected" && host && (
          <>
            {" "}
            <Link to={`/hosts/${host.id}`}>View {host.name}</Link>
          </>
        )}
        {hosts.error && !gaveUp && <> Couldn't check just now; retrying.</>}
      </p>
      {gaveUp && (
        <button type="button" className="btn small" onClick={() => void hosts.refetch()}>
          Check again
        </button>
      )}
    </div>
  );
}

const PAIRING_CLOCK_MS = 5_000;
