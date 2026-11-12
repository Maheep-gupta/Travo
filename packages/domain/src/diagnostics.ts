// The Settings > Diagnostics "Copy report" text (spec Part 12, area 10). Pure,
// so the future Expo app builds the same report.
//
// The report is meant to be pasted into a support request or a public issue,
// so it is built from an allowlist of facts: versions, states, counts, times
// and categories. It never reads names or titles (hosts are "Host 1", "Host 2"
// in list order), session ids, project labels, the project URL, keys, tokens,
// user ids or any session content. Free-text fields a connector controls
// (platform, connector version) are passed through only if they look like a
// plain identifier.
import { PROVIDER_ERROR_KINDS } from "@mc/contracts/constants";
import type { ProviderErrorKind } from "@mc/contracts";
import type { NotificationPrefs, SessionStatus } from "@mc/contracts";
import type { ConnectionState } from "./connectivity.js";
import { hostConnectivity, hostSourceOk } from "./hosts.js";
import type { DisplayStatus } from "./status.js";

/** A list as the client last saw it. `stale`: a later refresh failed and this is the older copy. */
export type DiagnosticsList<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; items: readonly T[]; stale?: boolean };

/** The host facts the report may use. Extra fields (a HostRow's name) are ignored. */
export interface DiagnosticsHost {
  /** Only used to count each host's sessions; never written to the report. */
  id: string;
  platform: string | null;
  connector_version: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  provider_error_since: string | null;
  provider_error_kind?: string | null;
}

/** The session facts the report may use. Extra fields (title, ids) are ignored. */
export interface DiagnosticsSession {
  host_id: string;
  status: SessionStatus;
  /** What the app shows after host connectivity and source health; optional. */
  displayStatus?: DisplayStatus;
}

export interface DiagnosticsInput {
  generatedAt: Date;
  appVersion: string;
  buildMode: string;
  /** e.g. "Browser tab", "Installed app". */
  runningAs: string;
  backend: "demo" | "supabase";
  schema: { state: "loading" } | { state: "failed" } | { state: "ready"; version: number | null };
  supportedSchema: { min: number; max: number };
  connection: ConnectionState;
  /** Live updates channel state, or null where there is none. */
  liveUpdates: string | null;
  hosts: DiagnosticsList<DiagnosticsHost>;
  sessions: DiagnosticsList<DiagnosticsSession> & { truncated?: boolean };
  notifications: {
    /** The browser's permission: "granted", "denied", "default" or "unsupported". */
    permission: string;
    /** This device's system-notification switch. */
    systemEnabled: boolean;
    /** Saved alert types; value null = never saved (defaults apply). */
    prefs: { state: "loading" } | { state: "failed" } | { state: "ready"; value: NotificationPrefs | null };
  };
  /** Keys present in this device's storage; null if storage can't be listed. Only sanitised names are reported. */
  storageKeys: readonly string[] | null;
}

const SAFE_TOKEN = /^[A-Za-z0-9._+-]{1,50}$/;

/** A connector-reported identifier, or a placeholder if it isn't a plain token. */
function safeToken(value: string | null): string {
  if (value === null || value === "") return "not reported";
  return SAFE_TOKEN.test(value) ? value : "(unrecognised value)";
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A storage key reduced to a name that says what it is and nothing about who
 * or where: Tavro keys up to their first ":" scope (which holds the backend
 * kind and user id), a Supabase sign-in key without its project ref, anything
 * else not listed by name. Returns null for keys that are only counted.
 */
export function diagnosticStorageKeyName(key: string): string | null {
  const auth = /^sb-[^:]*-auth-token(-code-verifier)?$/.exec(key);
  if (auth) return `sb-<project>-auth-token${auth[1] ?? ""}`;
  const base = (key.split(":")[0] ?? "").replace(UUID, "<id>");
  return /^(tavro|mc)\.[A-Za-z0-9._<>-]{1,60}$/.test(base) ? base : null;
}

function iso(at: number | string | null): string {
  if (at === null) return "never";
  const t = typeof at === "number" ? at : Date.parse(at);
  return Number.isNaN(t) ? "unknown" : new Date(t).toISOString();
}

function age(at: string | null, now: Date): string {
  if (at === null) return "never";
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.round((now.getTime() - t) / 1000);
  const ago = s < 0 ? `${-s} s in the future` : s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  return `${iso(at)} (${ago})`;
}

function connectionText(c: ConnectionState): string {
  switch (c.kind) {
    case "current":
      return "current";
    case "offline":
      return `offline (browser reports no network; data from ${iso(c.dataFrom)})`;
    case "unreachable":
      return `unreachable: ${c.cause} (data from ${iso(c.dataFrom)})`;
    case "stale":
      return `stale (data from ${iso(c.dataFrom)})`;
  }
}

function counts<K extends string>(keys: readonly K[]): string {
  if (keys.length === 0) return "none";
  const by = new Map<K, number>();
  for (const k of keys) by.set(k, (by.get(k) ?? 0) + 1);
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(PROVIDER_ERROR_KINDS);

function sourceHealth(h: DiagnosticsHost): string {
  if (hostSourceOk(h)) return "ok";
  const k = h.provider_error_kind;
  const kind: ProviderErrorKind | "category not reported" | "unrecognised category" =
    k === null || k === undefined ? "category not reported" : KNOWN_KINDS.has(k) ? (k as ProviderErrorKind) : "unrecognised category";
  return `failing since ${iso(h.provider_error_since)} (${kind})`;
}

function listHeader(label: string, list: DiagnosticsList<unknown>): string {
  if (list.state === "loading") return `${label}: still loading`;
  if (list.state === "failed") return `${label}: couldn't be loaded`;
  return `${label}: ${list.items.length}${list.stale ? " (older copy: the latest refresh failed)" : ""}`;
}

/** The plain-text diagnostics report. See the module comment for what it may contain. */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const now = input.generatedAt;
  const lines: string[] = [
    "Tavro diagnostics report",
    `Generated: ${now.toISOString()}`,
    "Contains no names, titles, project URL, keys, tokens or session content.",
    "",
    "App",
    `  Version: ${safeToken(input.appVersion)} (${safeToken(input.buildMode)})`,
    `  Running as: ${input.runningAs}`,
    "",
    "Backend",
    `  Kind: ${input.backend === "demo" ? "demo (simulated, in this browser)" : "Supabase (project not included)"}`,
    `  Schema: ${
      input.schema.state === "loading"
        ? "still loading"
        : input.schema.state === "failed"
          ? "couldn't be read"
          : input.schema.version === null
            ? "not reported"
            : `v${input.schema.version}`
    } (app supports v${input.supportedSchema.min}–v${input.supportedSchema.max})`,
    `  Data: ${connectionText(input.connection)}`,
    `  Live updates: ${input.liveUpdates ?? "none"}`,
    "",
  ];

  const sessions = input.sessions.state === "ready" ? input.sessions.items : null;
  lines.push(listHeader("Hosts", input.hosts));
  if (input.hosts.state === "ready") {
    input.hosts.items.forEach((h, i) => {
      lines.push(
        `  Host ${i + 1}: ${hostConnectivity(h, now)}; platform ${safeToken(h.platform)}; connector ${safeToken(h.connector_version)}`,
        `    Last seen: ${age(h.last_seen_at, now)}`,
        `    Session source: ${sourceHealth(h)}`,
      );
      if (sessions) lines.push(`    Sessions: ${counts(sessions.filter((s) => s.host_id === h.id).map((s) => s.status))}`);
    });
  }
  lines.push("");

  lines.push(`${listHeader("Sessions", input.sessions)}${input.sessions.truncated ? " (list capped: more exist than were loaded)" : ""}`);
  if (sessions) {
    lines.push(`  Reported: ${counts(sessions.map((s) => s.status))}`);
    const shown = sessions.flatMap((s) => (s.displayStatus ? [s.displayStatus] : []));
    if (shown.length > 0) lines.push(`  Shown as: ${counts(shown)}`);
    if (input.hosts.state === "ready") {
      const known = new Set(input.hosts.items.map((h) => h.id));
      const orphans = sessions.filter((s) => !known.has(s.host_id)).length;
      if (orphans > 0) lines.push(`  On hosts not in the host list: ${orphans}`);
    }
  }
  lines.push("");

  const n = input.notifications;
  lines.push("Notifications", `  Permission: ${safeToken(n.permission)}; system notifications on this device: ${n.systemEnabled ? "on" : "off"}`);
  if (n.prefs.state === "ready") {
    const prefs = n.prefs.value;
    lines.push(
      prefs === null
        ? "  Alert types: defaults (never saved)"
        : `  Alert types: ${(Object.keys(prefs) as (keyof NotificationPrefs)[])
            .sort()
            .map((k) => `${k} ${prefs[k] ? "on" : "off"}`)
            .join(", ")}`,
    );
  } else {
    lines.push(`  Alert types: ${n.prefs.state === "loading" ? "still loading" : "couldn't be loaded"}`);
  }
  lines.push("");

  if (input.storageKeys === null) {
    lines.push("Storage on this device: can't be listed (blocked or in memory only)");
  } else {
    const names = [...new Set(input.storageKeys.map(diagnosticStorageKeyName).filter((k): k is string => k !== null))].sort();
    const others = input.storageKeys.filter((k) => diagnosticStorageKeyName(k) === null).length;
    lines.push(`Storage keys on this device (names only): ${names.length > 0 ? names.join(", ") : "none"}${others > 0 ? `; ${others} other key(s) not listed` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}
