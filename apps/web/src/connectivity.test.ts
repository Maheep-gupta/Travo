// The connectivity rules (offline banner, spec 3.5, 14.2) are tested with the
// domain code in packages/domain/test/connectivity.test.ts. What stays here:
// the web re-export, install detection and clearing local data.
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@mc/api-client/demo";
import * as domain from "@mc/domain";
import { AlertStore } from "./alert-store.js";
import { installState } from "./app-info.js";
import * as connectivity from "./connectivity.js";
import { clearLocalTavroData } from "./local-data.js";

const NOW = Date.UTC(2026, 10, 2, 14, 30);

describe("connectivity re-export", () => {
  it("is the domain's code, not a copy", () => {
    expect(connectivity.connectionState).toBe(domain.connectionState);
    expect(connectivity.connectionMessage).toBe(domain.connectionMessage);
    expect(connectivity.summarizeQueries).toBe(domain.summarizeQueries);
    expect(connectivity.shouldRetryFetch).toBe(domain.shouldRetryFetch);
    expect(connectivity.FETCH_GRACE_MS).toBe(15_000);
  });
});

describe("installState", () => {
  const mm = (standalone: boolean) => (query: string) => ({ matches: standalone && query === "(display-mode: standalone)" });

  it("detects an installed app, a browser tab, and an unknown environment", () => {
    expect(installState({ matchMedia: mm(true) })).toBe("installed");
    expect(installState({ matchMedia: mm(false) })).toBe("browser");
    expect(installState({ matchMedia: mm(false), standalone: true })).toBe("installed");
    expect(installState({})).toBe("unknown");
  });
});

describe("clearLocalTavroData", () => {
  it("removes this account's alerts and this device's preferences, and nothing else", () => {
    const storage = new MemoryStorage();
    const store = new AlertStore(storage, "tavro.alerts.v1:demo:u1");
    store.add([{ id: "a1", kind: "failed", sessionId: "s1", hostId: "h1", at: new Date(NOW).toISOString(), isDemo: true }]);
    storage.setItem("tavro.theme.v1", "light");
    storage.setItem("tavro.systemNotifications.v1", "on");
    storage.setItem("tavro.systemNotificationNames.v1:tavro.alerts.v1:demo:u1", "on");
    storage.setItem("tavro.alerts.v1:demo:u2", "[]");
    storage.setItem("mc.backend", '{"kind":"demo"}');

    clearLocalTavroData(storage, store, "demo", "u1");

    expect(store.getSnapshot()).toEqual([]);
    expect(storage.getItem("tavro.alerts.v1:demo:u1")).toBe("[]");
    expect(storage.getItem("tavro.theme.v1")).toBeNull();
    expect(storage.getItem("tavro.systemNotifications.v1")).toBeNull();
    expect(storage.getItem("tavro.systemNotificationNames.v1:tavro.alerts.v1:demo:u1")).toBeNull();
    // Another account's list and the connection are left to their own controls.
    expect(storage.getItem("tavro.alerts.v1:demo:u2")).toBe("[]");
    expect(storage.getItem("mc.backend")).toBe('{"kind":"demo"}');
  });
});
