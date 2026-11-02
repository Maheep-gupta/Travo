// The per-user boundary of local storage across sign-ins (M2): an expired
// sign-in keeps the same person's alert history; a different person's
// arrival removes the previous one's.
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@mc/api-client/demo";
import { AlertStore, alertStorageKey } from "./alert-store.js";
import { clearLocalTavroData, forgetUserLocalData, lastUserKey, noteSignedInUser } from "./local-data.js";

const NAMES_PREFIX = "tavro.systemNotificationNames.v1:";

function seed(storage: MemoryStorage, backend: string, userId: string): void {
  storage.setItem(alertStorageKey(backend, userId), '[{"id":"x"}]');
  storage.setItem(NAMES_PREFIX + alertStorageKey(backend, userId), "on");
}

describe("noteSignedInUser", () => {
  it("records the first user (id only) and forgets nothing", () => {
    const storage = new MemoryStorage();
    seed(storage, "supabase", "a");
    expect(noteSignedInUser(storage, "supabase", "a")).toBeNull();
    expect(storage.getItem(lastUserKey("supabase"))).toBe("a");
    expect(storage.getItem(alertStorageKey("supabase", "a"))).toBe('[{"id":"x"}]');
  });

  it("keeps the same user's history when they sign back in", () => {
    const storage = new MemoryStorage();
    noteSignedInUser(storage, "supabase", "a");
    seed(storage, "supabase", "a");
    expect(noteSignedInUser(storage, "supabase", "a")).toBeNull();
    expect(storage.getItem(alertStorageKey("supabase", "a"))).toBe('[{"id":"x"}]');
    expect(storage.getItem(NAMES_PREFIX + alertStorageKey("supabase", "a"))).toBe("on");
  });

  it("forgets the previous user's alerts and names opt-in when a different user signs in", () => {
    const storage = new MemoryStorage();
    noteSignedInUser(storage, "supabase", "a");
    seed(storage, "supabase", "a");
    seed(storage, "supabase", "b");
    storage.setItem("tavro.systemNotifications.v1", "on");

    expect(noteSignedInUser(storage, "supabase", "b")).toBe("a");
    expect(storage.getItem(lastUserKey("supabase"))).toBe("b");
    expect(storage.getItem(alertStorageKey("supabase", "a"))).toBeNull();
    expect(storage.getItem(NAMES_PREFIX + alertStorageKey("supabase", "a"))).toBeNull();
    // B's own data and the device-wide switch stay.
    expect(storage.getItem(alertStorageKey("supabase", "b"))).toBe('[{"id":"x"}]');
    expect(storage.getItem("tavro.systemNotifications.v1")).toBe("on");
  });

  it("keeps backends apart", () => {
    const storage = new MemoryStorage();
    noteSignedInUser(storage, "supabase", "a");
    seed(storage, "supabase", "a");
    expect(noteSignedInUser(storage, "demo", "demo-user")).toBeNull();
    expect(storage.getItem(alertStorageKey("supabase", "a"))).toBe('[{"id":"x"}]');
    expect(storage.getItem(lastUserKey("supabase"))).toBe("a");
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: (): void => {
        throw new Error("SecurityError");
      },
      removeItem: (): void => {
        throw new Error("SecurityError");
      },
    };
    expect(noteSignedInUser(blocked, "supabase", "a")).toBeNull();
    expect(() => forgetUserLocalData(blocked, "supabase", "a")).not.toThrow();
  });
});

describe("clearLocalTavroData and the last-user record", () => {
  it("removes this account's record, and leaves a record naming someone else alone", () => {
    const storage = new MemoryStorage();
    noteSignedInUser(storage, "supabase", "a");
    clearLocalTavroData(storage, new AlertStore(storage, alertStorageKey("supabase", "a")), "supabase", "a");
    expect(storage.getItem(lastUserKey("supabase"))).toBeNull();

    noteSignedInUser(storage, "supabase", "b");
    clearLocalTavroData(storage, new AlertStore(storage, alertStorageKey("supabase", "a")), "supabase", "a");
    expect(storage.getItem(lastUserKey("supabase"))).toBe("b");
  });
});
