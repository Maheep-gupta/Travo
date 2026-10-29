import type { ReactNode } from "react";
import { STATUS_LABEL, type DisplayStatus, type HostConnectivity } from "@mc/domain";
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

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Notice tone="error">
      <p>{error.message || "Something went wrong."}</p>
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

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-line" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function SessionListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading sessions">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skel" />
      ))}
    </div>
  );
}
