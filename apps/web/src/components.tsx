import type { ReactNode } from "react";
import { ApiError } from "@mc/api-client/demo";
import { STATUS_LABEL, formatDataTime, type DisplayStatus, type HostConnectivity, type RefreshFailure, type StatusSource } from "@mc/domain";
import { IconAlert, IconCheck, IconInbox, IconInfo } from "./icons.js";

export function StatusBadge({ status, variant = "plain" }: { status: DisplayStatus; variant?: "plain" | "pill" | "lg" }) {
  const cls = variant === "plain" ? "" : variant === "pill" ? " pill" : " pill lg";
  return (
    <span className={`status st-${status}${cls}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DemoTag() {
  return (
    <span className="tag demo" title="Simulated data — not real Claude activity">
      Demo
    </span>
  );
}

const CONNECTIVITY_LABEL: Record<HostConnectivity, string> = {
  online: "Online",
  disconnected: "Disconnected",
  never_connected: "Never connected",
  revoked: "Revoked",
};

export function ConnectivityBadge({ connectivity }: { connectivity: HostConnectivity }) {
  return (
    <span className={`conn conn-${connectivity}`}>
      <span className="dot" aria-hidden="true" />
      {CONNECTIVITY_LABEL[connectivity]}
    </span>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h1>{title}</h1>
      {children && <div className="lede">{children}</div>}
    </header>
  );
}

export function EmptyState({ title, children, icon = <IconInbox /> }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state" role="status">
      {icon}
      <h2>{title}</h2>
      {children}
    </div>
  );
}

type NoticeTone = "info" | "warn" | "error" | "success";
const NOTICE_ICON: Record<NoticeTone, ReactNode> = {
  info: <IconInfo />,
  warn: <IconAlert />,
  error: <IconAlert />,
  success: <IconCheck />,
};

export function Notice({ tone = "info", children, role }: { tone?: NoticeTone; children: ReactNode; role?: "alert" | "status" | "note" }) {
  return (
    <div className={`notice ${tone === "info" ? "" : tone}`} role={role ?? (tone === "error" ? "alert" : "note")}>
      {NOTICE_ICON[tone]}
      <div>{children}</div>
    </div>
  );
}

/**
 * Only ApiError messages are written for users; anything else (e.g. a
 * schema-parse error) could expose field names or values.
 */
function safeErrorMessage(error: Error | null): string {
  return error instanceof ApiError && error.message ? error.message : "Something went wrong. Try again in a moment.";
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Notice tone="error">
      <p>{safeErrorMessage(error)}</p>
      {onRetry && (
        <div className="actions">
          <button type="button" className="btn small" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </Notice>
  );
}

/**
 * One source failed while the rest of the page loaded (spec 3.5 partial data):
 * names what is missing, says what that means for what is shown, and offers a
 * retry. Announced like an error; the page around it stays usable.
 */
export function MissingDataNotice({
  title,
  error,
  onRetry,
  children,
}: {
  title: string;
  error: Error | null;
  onRetry: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="missing-data">
      <Notice tone="warn" role="alert">
        <p>
          <strong>{title}</strong> {safeErrorMessage(error)}
        </p>
        {children}
        <div className="actions">
          <button type="button" className="btn small" onClick={onRetry}>
            Try again
          </button>
        </div>
      </Notice>
    </div>
  );
}

const REFRESH_SOURCE_LABEL: Record<StatusSource, string> = { sessions: "sessions", hosts: "host status" };

/**
 * A status list's latest refresh failed after it had loaded: its data stays on
 * screen (marked stale), this says from when, and offers a retry. Polite, as
 * the offline banner may say much the same once the outage lasts.
 */
export function RefreshFailedNotice({ failure, now, onRetry }: { failure: RefreshFailure | null; now: Date; onRetry: () => void }) {
  if (!failure) return null;
  const what = failure.sources.map((s) => REFRESH_SOURCE_LABEL[s]).join(" and ");
  const from = failure.dataFrom === null ? "earlier" : formatDataTime(failure.dataFrom, now.getTime());
  return (
    <div className="missing-data">
      <Notice tone="warn" role="status">
        <p>
          <strong>
            Couldn't refresh {what} — showing data from {from}.
          </strong>{" "}
          Statuses may have changed since then. Tavro keeps trying.
        </p>
        <div className="actions">
          <button type="button" className="btn small" onClick={onRetry}>
            Try again
          </button>
        </div>
      </Notice>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-line" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function SessionListSkeleton({ count = 4, label = "Loading sessions…" }: { count?: number; label?: string }) {
  // The label is real text (not aria-label) so the status region has content to announce.
  return (
    <div className="skeleton" role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skel" aria-hidden="true" />
      ))}
    </div>
  );
}
