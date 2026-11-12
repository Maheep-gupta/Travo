import { describe, expect, it } from "vitest";
import type { HostRow } from "@mc/contracts";
import { SETUP_STATE_LABEL, setupChecklist, setupSummary, type SetupChecklistInput, type SetupStepId, type SetupStepState } from "../src/index.js";
import { host, now } from "./fixtures.js";

const paired = (id: string, lastSeenAgoMs: number | null, patch: Partial<HostRow> = {}): HostRow => ({
  ...host(id, lastSeenAgoMs),
  paired_at: now.toISOString(),
  ...patch,
});

/** A signed-in real project with one healthy host and one session: everything required is done. */
const ready: SetupChecklistInput = {
  backend: "supabase",
  signedIn: true,
  hosts: { state: "ready", data: [paired("laptop", 1_000)] },
  sessions: { state: "ready", count: 1, dropped: 0 },
  sync: "current",
  notifications: "default",
  now,
};

const states = (i: SetupChecklistInput): Record<SetupStepId, SetupStepState> =>
  Object.fromEntries(setupChecklist(i).steps.map((s) => [s.id, s.state])) as Record<SetupStepId, SetupStepState>;

const stepOf = (i: SetupChecklistInput, id: SetupStepId) => {
  const s = setupChecklist(i).steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

describe("setup checklist", () => {
  it("is complete only when every required step has evidence", () => {
    const c = setupChecklist(ready);
    expect(c.complete).toBe(true);
    expect(c.current).toBeNull();
    expect(c.done).toBe(6);
    expect(c.total).toBe(6);
    expect(setupSummary(c)).toBe("Setup complete.");
    // Notifications are optional and never hold setup back.
    expect(states(ready).notifications).toBe("optional");
  });

  it("before a backend is chosen, only choosing one is actionable", () => {
    const c = setupChecklist({ ...ready, backend: "none", signedIn: false, hosts: { state: "loading", data: null }, sessions: { state: "loading", count: null, dropped: 0 } });
    expect(c.current).toBe("backend");
    expect(c.steps[0]?.action).toEqual({ kind: "choose_backend" });
    expect(c.steps[1]).toMatchObject({ id: "sign_in", state: "blocked", blockedBy: "backend", action: null });
    // Not "checking": there is nothing to check yet.
    expect(states({ ...ready, backend: "none", signedIn: false, hosts: { state: "loading", data: null } })).toMatchObject({
      pair_host: "blocked",
      heartbeat: "blocked",
      first_session: "blocked",
    });
    expect(c.complete).toBe(false);
    // Chosen but signed out: signing in is next.
    expect(setupChecklist({ ...ready, signedIn: false }).current).toBe("sign_in");
  });

  it("walks a new project through pairing, first heartbeat and first session", () => {
    const empty = { ...ready, hosts: { state: "ready" as const, data: [] }, sessions: { state: "ready" as const, count: 0, dropped: 0 } };
    expect(states(empty)).toMatchObject({ backend: "done", sign_in: "done", pair_host: "current", heartbeat: "blocked", source: "blocked", first_session: "blocked" });
    expect(stepOf(empty, "pair_host").action).toEqual({ kind: "hosts" });
    expect(stepOf(empty, "heartbeat").blockedBy).toBe("pair_host");

    // A code was created but never used: the host row exists without paired_at.
    const codeOnly = { ...empty, hosts: { state: "ready" as const, data: [host("new", null)] } };
    expect(stepOf(codeOnly, "pair_host")).toMatchObject({ state: "current" });
    expect(stepOf(codeOnly, "pair_host").detail).toMatch(/no connector has used it/);

    const pairedOnly = { ...empty, hosts: { state: "ready" as const, data: [paired("laptop", null)] } };
    expect(states(pairedOnly)).toMatchObject({ pair_host: "done", heartbeat: "current", source: "blocked" });
    expect(stepOf(pairedOnly, "heartbeat").action).toEqual({ kind: "host", hostId: "laptop" });

    const reporting = { ...empty, hosts: { state: "ready" as const, data: [paired("laptop", 1_000)] } };
    expect(states(reporting)).toMatchObject({ heartbeat: "done", source: "done", first_session: "current" });
    expect(setupSummary(setupChecklist(reporting))).toBe("5 of 6 steps done.");
  });

  it("never counts revoked hosts as paired", () => {
    const revoked = { ...ready, hosts: { state: "ready" as const, data: [paired("old", 1_000, { revoked_at: now.toISOString() })] } };
    expect(stepOf(revoked, "pair_host")).toMatchObject({ state: "current" });
    expect(stepOf(revoked, "pair_host").detail).toMatch(/revoked/);
  });

  it("says when a connector stopped reporting, and which host to look at", () => {
    const stopped = { ...ready, hosts: { state: "ready" as const, data: [paired("a", 10 * 60_000), paired("b", 60 * 60_000)] } };
    const s = stepOf(stopped, "heartbeat");
    expect(s.state).toBe("current");
    expect(s.detail).toMatch(/a last checked in 10m ago/);
    expect(s.action).toEqual({ kind: "host", hostId: "a" });
    // Sessions seen earlier are still evidence of a first session.
    expect(stepOf(stopped, "first_session").state).toBe("done");
  });

  it("flags a failing session source", () => {
    const failing = { ...ready, hosts: { state: "ready" as const, data: [paired("laptop", 1_000, { provider_error_since: new Date(now.getTime() - 5 * 60_000).toISOString() })] } };
    expect(states(failing)).toMatchObject({ heartbeat: "done", source: "current" });
    // The start time is the failure's, not its category's: it isn't attached to the category.
    expect(stepOf(failing, "source").detail).toMatch(/has had a problem since 5m ago\. The host can't read its sessions: The connector didn't report why\./);
    // Schema v4 categories use the host pages' wording (sourceFailureText); a missing one keeps the generic text.
    const since = new Date(now.getTime() - 5 * 60_000).toISOString();
    const withKind = (kind: HostRow["provider_error_kind"]) => ({ ...ready, hosts: { state: "ready" as const, data: [paired("laptop", 1_000, { provider_error_since: since, provider_error_kind: kind })] } });
    expect(stepOf(withKind("auth_required"), "source").detail).toMatch(/The host can't read its sessions: Claude Code isn't signed in on this computer./);
    expect(stepOf(withKind("writes_not_applied"), "source").detail).toMatch(/The host's session updates aren't being saved: /);
    expect(stepOf(withKind("writes_not_applied"), "source").detail).not.toMatch(/can't read/);
    expect(stepOf(withKind(null), "source").detail).not.toMatch(/sign in|installed/);
    // One healthy host is enough.
    const mixed = { ...failing, hosts: { state: "ready" as const, data: [...(failing.hosts.data ?? []), paired("other", 1_000)] } };
    expect(stepOf(mixed, "source").state).toBe("done");
  });

  it("distinguishes loading and load failures from not done", () => {
    const loading = { ...ready, hosts: { state: "loading" as const, data: null }, sessions: { state: "loading" as const, count: null, dropped: 0 } };
    expect(states(loading)).toMatchObject({ pair_host: "unknown", heartbeat: "unknown", source: "unknown", first_session: "unknown" });
    expect(setupChecklist(loading).current).toBeNull();
    expect(setupChecklist(loading).complete).toBe(false);

    const failed = { ...ready, hosts: { state: "failed" as const, data: null }, sessions: { state: "failed" as const, count: null, dropped: 0 } };
    expect(stepOf(failed, "pair_host")).toMatchObject({ state: "unknown", action: { kind: "retry" } });
    expect(stepOf(failed, "first_session")).toMatchObject({ state: "unknown", action: { kind: "retry" } });
  });

  it("only confirms present-tense steps from a current copy", () => {
    for (const sync of ["offline", "unreachable", "stale"] as const) {
      const c = { ...ready, sync, hosts: { state: "refresh_failed" as const, data: ready.hosts.data } };
      // Pairing and sessions already happened; that evidence survives.
      expect(states(c)).toMatchObject({ pair_host: "done", heartbeat: "unknown", source: "unknown", first_session: "done" });
      expect(stepOf(c, "heartbeat").detail).toMatch(/^Can't confirm right now/);
      expect(setupChecklist(c).complete).toBe(false);
    }
  });

  it("keeps unreadable sessions apart from no sessions", () => {
    const dropped = { ...ready, sessions: { state: "ready" as const, count: 0, dropped: 2 } };
    expect(stepOf(dropped, "first_session")).toMatchObject({ state: "current" });
    expect(stepOf(dropped, "first_session").detail).toMatch(/2 sessions arrived but couldn't be read/);
  });

  it("labels demo evidence and says so in the summary", () => {
    const demo = { ...ready, backend: "demo" as const };
    const c = setupChecklist(demo);
    expect(c.demo).toBe(true);
    expect(c.steps.find((s) => s.id === "pair_host")).toMatchObject({ state: "done", demo: true });
    expect(c.steps.find((s) => s.id === "pair_host")?.detail).toMatch(/^Simulated demo host/);
    expect(setupSummary(c)).toMatch(/^Demo setup complete/);
    expect(setupSummary(setupChecklist({ ...demo, sessions: { state: "ready", count: 0, dropped: 0 } }))).toBe("5 of 6 steps done (demo data).");
  });

  it("treats allowed notifications as done, and blocked, unsupported or undecided as optional", () => {
    expect(stepOf({ ...ready, notifications: "granted" }, "notifications").state).toBe("done");
    // Blocked is never shown done; in-app alerts still work.
    expect(stepOf({ ...ready, notifications: "denied" }, "notifications")).toMatchObject({ state: "optional", detail: expect.stringContaining("In-app alerts still work") });
    expect(stepOf({ ...ready, notifications: "unsupported" }, "notifications").state).toBe("optional");
    expect(stepOf({ ...ready, notifications: "default" }, "notifications")).toMatchObject({ state: "optional", optional: true, action: { kind: "notifications" } });
    // No link to settings before there is anyone signed in.
    expect(stepOf({ ...ready, signedIn: false }, "notifications").action).toBeNull();
  });

  it("has a text label for every state", () => {
    for (const s of ["done", "current", "blocked", "unknown", "optional"] as const) expect(SETUP_STATE_LABEL[s]).toBeTruthy();
  });
});
