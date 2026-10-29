import { describe, expect, it } from "vitest";
import { DemoSimulator } from "../src/index.js";

describe("DemoSimulator", () => {
  it("is deterministic for a given seed and clock", () => {
    const now = () => Date.parse("2026-10-29T12:00:00Z");
    const a = new DemoSimulator({ seed: 7, now });
    const b = new DemoSimulator({ seed: 7, now });
    for (let i = 0; i < 20; i++) {
      a.tick();
      b.tick();
    }
    expect(a.observe()).toEqual(b.observe());
  });

  it("labels everything as simulated", () => {
    const sim = new DemoSimulator();
    for (const o of sim.observe()) {
      expect(o.external_id.startsWith("demo-")).toBe(true);
      expect(o.status_reason.startsWith("Simulated")).toBe(true);
      for (const m of sim.messages(o.external_id)) expect(m.text.startsWith("(demo)")).toBe(true);
    }
  });

  it("covers every attention state at start", () => {
    const statuses = new Set(new DemoSimulator().observe().map((o) => o.status));
    for (const s of ["running", "waiting_for_input", "approval_required", "completed", "failed"]) expect(statuses).toContain(s);
  });
});
