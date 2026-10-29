// Web implementations of platform-specific capabilities. A React Native app
// would provide its own versions (SecureStore, AsyncStorage) behind the same
// KeyValueStorage interface from @mc/api-client.
//
// Backends are loaded on demand: demo mode never downloads supabase-js or
// zod, and the Supabase backend is only fetched once a project is connected.
import { MemoryStorage, type KeyValueStorage, type TavroApi } from "@mc/api-client/demo";

const BACKEND_KEY = "mc.backend";

/** localStorage with graceful fallback (private mode, blocked storage). */
export const webStorage: KeyValueStorage = (() => {
  try {
    const probe = "__mc_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return {
      getItem: (k) => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
      removeItem: (k) => window.localStorage.removeItem(k),
    };
  } catch {
    return new MemoryStorage();
  }
})();

export interface SupabaseConnection {
  url: string;
  publishableKey: string;
}

/**
 * For "supabase", `config` is only shape-checked here; it is fully validated
 * (https / loopback, privileged-key rejection) by ConnectionConfig inside
 * createSupabaseApi before any network call.
 */
export type BackendChoice = { kind: "demo" } | { kind: "supabase"; config: SupabaseConnection };

function isConnection(v: unknown): v is SupabaseConnection {
  return typeof v === "object" && v !== null && typeof (v as SupabaseConnection).url === "string" && typeof (v as SupabaseConnection).publishableKey === "string";
}

export function loadBackendChoice(): BackendChoice | null {
  const raw = webStorage.getItem(BACKEND_KEY);
  // `?demo=1` opens demo mode directly (shareable demo links). It never
  // overrides a saved backend and can only ever select simulated data.
  if (typeof raw !== "string") return new URLSearchParams(window.location.search).get("demo") === "1" ? { kind: "demo" } : null;
  try {
    const parsed = JSON.parse(raw) as { kind?: string; config?: unknown };
    if (parsed.kind === "demo") return { kind: "demo" };
    if (parsed.kind === "supabase" && isConnection(parsed.config)) return { kind: "supabase", config: parsed.config };
  } catch {
    // fall through
  }
  return null;
}

export function saveBackendChoice(choice: BackendChoice | null): void {
  if (choice === null) void webStorage.removeItem(BACKEND_KEY);
  else void webStorage.setItem(BACKEND_KEY, JSON.stringify(choice));
}

export async function createApi(choice: BackendChoice): Promise<TavroApi> {
  if (choice.kind === "demo") {
    const { createDemoApi } = await import("@mc/api-client/demo");
    return createDemoApi();
  }
  const { createSupabaseApi } = await import("@mc/api-client/supabase");
  return createSupabaseApi(choice.config, webStorage);
}
