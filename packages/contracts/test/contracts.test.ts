import { describe, expect, it } from "vitest";
import { HeartbeatInput, HostRow, PROVIDER_ERROR_KINDS, PairHostRequest, SessionUpsert } from "../src/index.js";

describe("contracts", () => {
  it("rejects malformed pairing codes", () => {
    expect(PairHostRequest.safeParse({ code: "ABCD-EFGH-JKLM" }).success).toBe(true);
    expect(PairHostRequest.safeParse({ code: "abcd-efgh-jklm" }).success).toBe(false);
    expect(PairHostRequest.safeParse({ code: "'; drop table hosts;--" }).success).toBe(false);
  });

  it("rejects unknown statuses and oversized fields from connectors", () => {
    const valid = {
      provider: "claude-code",
      external_id: "93f6309d-41b9-4d0b-a46b-154023503436",
      title: "x",
      project_label: null,
      status: "running",
      status_reason: null,
      status_source: "cli_agents_list",
      last_activity_at: null,
      last_event_summary: null,
      capabilities: ["discover"],
      is_demo: false,
      started_at: null,
      ended_at: null,
      observed_at: "2026-11-03T10:00:00.000Z",
    };
    expect(SessionUpsert.safeParse(valid).success).toBe(true);
    // Schema v3: every write carries its observation time.
    const noObservation = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== "observed_at"));
    expect(SessionUpsert.safeParse(noObservation).success).toBe(false);
    expect(SessionUpsert.safeParse({ ...valid, observed_at: "yesterday" }).success).toBe(false);
    expect(SessionUpsert.safeParse({ ...valid, status: "done" }).success).toBe(false);
    expect(SessionUpsert.safeParse({ ...valid, title: "x".repeat(301) }).success).toBe(false);
    expect(SessionUpsert.safeParse({ ...valid, capabilities: ["shell"] }).success).toBe(false);
  });

  it("reads a host's failure category (schema v4), treating an unknown one as none", () => {
    const row = {
      id: "93f6309d-41b9-4d0b-a46b-154023503436",
      owner_id: "93f6309d-41b9-4d0b-a46b-154023503437",
      name: "Laptop",
      platform: "win32",
      connector_version: "1",
      remote_control_allowed: false,
      last_seen_at: "2026-10-29T12:00:00Z",
      provider_error_since: "2026-10-29T12:00:00Z",
      paired_at: null,
      revoked_at: null,
      created_at: "2026-10-29T12:00:00Z",
    };
    expect(HostRow.parse({ ...row, provider_error_kind: "cli_missing" }).provider_error_kind).toBe("cli_missing");
    // A category from a newer schema must not fail the whole host list.
    expect(HostRow.parse({ ...row, provider_error_kind: "some_future_kind" }).provider_error_kind).toBeNull();
    expect(HostRow.parse({ ...row, provider_error_kind: null }).provider_error_kind).toBeNull();
    expect(HostRow.parse(row).provider_error_kind ?? null).toBeNull();
  });

  it("sends only a fixed category with a heartbeat", () => {
    const base = { platform: "win32", connector_version: "1", remote_control_allowed: false };
    for (const kind of PROVIDER_ERROR_KINDS) expect(HeartbeatInput.safeParse({ ...base, provider_ok: false, provider_error_kind: kind }).success).toBe(true);
    expect(HeartbeatInput.safeParse({ ...base, provider_ok: false, provider_error_kind: "claude: not found at /usr/bin" }).success).toBe(false);
    expect(HeartbeatInput.safeParse({ ...base, provider_ok: true }).success).toBe(false); // the field is required
  });

  it("names a category exactly when the source is failing (v4 connectors)", () => {
    const base = { platform: "win32", connector_version: "1", remote_control_allowed: false };
    expect(HeartbeatInput.safeParse({ ...base, provider_ok: true, provider_error_kind: null }).success).toBe(true);
    expect(HeartbeatInput.safeParse({ ...base, provider_ok: false, provider_error_kind: null }).success).toBe(false);
    expect(HeartbeatInput.safeParse({ ...base, provider_ok: true, provider_error_kind: "cli_missing" }).success).toBe(false);
  });
});
