import { DEFAULT_NOTIFICATION_PREFS } from "@mc/contracts/constants";
import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport, diagnosticStorageKeyName, type DiagnosticsInput } from "../src/diagnostics.js";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

// Values that must never reach the report, planted wherever a caller could pass them.
const SECRETS = {
  hostName: "Maria's work laptop",
  title: "Refactor billing for ACME",
  projectLabel: "acme-billing",
  url: "https://abcdefghijklmnopqrst.supabase.co",
  ref: "abcdefghijklmnopqrst",
  key: "sb_publishable_SECRETKEY123",
  token: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
  userId: "8d3c2b1a-0000-4000-8000-00000000abcd",
  hostId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  externalId: "93f6309d-41b9-4d0b-a46b-154023503436",
  path: "/home/maria/projects/acme",
};

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  const hostRow = {
    id: SECRETS.hostId,
    owner_id: SECRETS.userId,
    name: SECRETS.hostName,
    platform: "win32",
    connector_version: "0.1.0",
    remote_control_allowed: false,
    last_seen_at: ago(20_000),
    provider_error_since: ago(300_000),
    provider_error_kind: "cli_missing" as const,
    paired_at: ago(86_400_000),
    revoked_at: null,
    created_at: ago(86_400_000),
  };
  const second = { ...hostRow, id: "33333333-3333-4333-8333-333333333333", name: "Desk", platform: SECRETS.path, connector_version: SECRETS.url, last_seen_at: ago(3 * 3_600_000), provider_error_since: null, provider_error_kind: null };
  const sessionRow = {
    id: SECRETS.sessionId,
    host_id: SECRETS.hostId,
    external_id: SECRETS.externalId,
    title: SECRETS.title,
    project_label: SECRETS.projectLabel,
    status: "running" as const,
    status_reason: SECRETS.path,
    last_event_summary: SECRETS.title,
    displayStatus: "source_unavailable" as const,
    hostName: SECRETS.hostName,
  };
  return {
    generatedAt: NOW,
    appVersion: "0.1.0",
    buildMode: "production",
    runningAs: "Browser tab",
    backend: "supabase",
    schema: { state: "ready", version: 4 },
    supportedSchema: { min: 4, max: 4 },
    connection: { kind: "current" },
    liveUpdates: "on",
    hosts: { state: "ready", items: [hostRow, second] },
    sessions: {
      state: "ready",
      items: [sessionRow, { ...sessionRow, status: "waiting_for_input" }, { ...sessionRow, host_id: second.id, status: "ended", displayStatus: "ended" }],
    },
    notifications: { permission: "granted", systemEnabled: true, prefs: { state: "ready", value: DEFAULT_NOTIFICATION_PREFS } },
    storageKeys: [
      "mc.backend",
      "tavro.theme.v1",
      `tavro.alerts.v1:supabase:${SECRETS.userId}`,
      `tavro.notificationBurst.v1:tavro.alerts.v1:supabase:${SECRETS.userId}`,
      `tavro.lastUser.v1:supabase`,
      `sb-${SECRETS.ref}-auth-token`,
      `sb-${SECRETS.ref}-auth-token-code-verifier`,
      `someone-else:${SECRETS.token}`,
    ],
    ...over,
  };
}

describe("buildDiagnosticsReport", () => {
  it("never contains names, titles, ids, URLs, keys, tokens, paths or user ids", () => {
    const report = buildDiagnosticsReport(input());
    for (const [what, value] of Object.entries(SECRETS)) {
      expect(report, what).not.toContain(value);
    }
    expect(report).not.toMatch(/https?:\/\//);
    expect(report).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(report).not.toMatch(/eyJ|sb_publishable|sb_secret/);
  });

  it("reports versions, backend kind, data state, hosts by number and session counts", () => {
    const report = buildDiagnosticsReport(input());
    expect(report).toContain("Version: 0.1.0 (production)");
    expect(report).toContain("Kind: Supabase (project not included)");
    expect(report).toContain("Schema: v4 (app supports v4–v4)");
    expect(report).toContain("Data: current");
    expect(report).toContain("Hosts: 2");
    expect(report).toContain("Host 1: online; platform win32; connector 0.1.0");
    expect(report).toContain(`Session source: failing since ${ago(300_000)} (cli_missing)`);
    expect(report).toContain("Sessions: running 1, waiting_for_input 1");
    // A connector-controlled field that isn't a plain identifier is replaced.
    expect(report).toContain("Host 2: disconnected; platform (unrecognised value); connector (unrecognised value)");
    expect(report).toContain("Last seen: 2026-11-12T09:00:00.000Z (3 h ago)");
    expect(report).toContain("Reported: ended 1, running 1, waiting_for_input 1");
    expect(report).toContain("Shown as: ended 1, source_unavailable 2");
    expect(report).toContain("Permission: granted; system notifications on this device: on");
    expect(report).toContain("on_completed on");
    expect(report).toContain("on_host_reconnected off");
  });

  it("lists storage keys by name only, without user ids or the project ref", () => {
    const report = buildDiagnosticsReport(input());
    expect(report).toContain(
      "Storage keys on this device (names only): mc.backend, sb-<project>-auth-token, sb-<project>-auth-token-code-verifier, tavro.alerts.v1, tavro.lastUser.v1, tavro.notificationBurst.v1, tavro.theme.v1; 1 other key(s) not listed",
    );
    expect(diagnosticStorageKeyName(`tavro.x.${SECRETS.userId}`)).toBe("tavro.x.<id>");
    expect(diagnosticStorageKeyName("random")).toBeNull();
  });

  it("says when something couldn't be loaded or listed instead of guessing", () => {
    const report = buildDiagnosticsReport(
      input({
        backend: "demo",
        schema: { state: "failed" },
        connection: { kind: "unreachable", cause: "paused", dataFrom: null },
        liveUpdates: null,
        hosts: { state: "failed" },
        sessions: { state: "loading" },
        notifications: { permission: "unsupported", systemEnabled: false, prefs: { state: "ready", value: null } },
        storageKeys: null,
      }),
    );
    expect(report).toContain("Kind: demo (simulated, in this browser)");
    expect(report).toContain("Schema: couldn't be read");
    expect(report).toContain("Data: unreachable: paused (data from never)");
    expect(report).toContain("Hosts: couldn't be loaded");
    expect(report).toContain("Sessions: still loading");
    expect(report).toContain("Alert types: defaults (never saved)");
    expect(report).toContain("Storage on this device: can't be listed");
  });

  it("marks a capped or older list, a failure without a category, and sessions on unknown hosts", () => {
    const base = input();
    if (base.hosts.state !== "ready" || base.sessions.state !== "ready") throw new Error("fixture");
    const [first] = base.hosts.items;
    if (!first) throw new Error("fixture");
    const report = buildDiagnosticsReport({
      ...base,
      hosts: { state: "ready", items: [{ ...first, provider_error_kind: null }], stale: true },
      sessions: { ...base.sessions, truncated: true },
    });
    expect(report).toContain("Hosts: 1 (older copy: the latest refresh failed)");
    expect(report).toContain("(category not reported)");
    expect(report).toContain("Sessions: 3 (list capped: more exist than were loaded)");
    expect(report).toContain("On hosts not in the host list: 1");
  });
});
