import { describe, expect, it } from "vitest";
import { PairHostRequest, SessionUpsert } from "../src/index.js";

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
});
