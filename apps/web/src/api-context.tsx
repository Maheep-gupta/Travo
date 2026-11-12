import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TavroApi } from "@mc/api-client/demo";
import { createApi, loadBackendChoice, saveBackendChoice, type BackendChoice } from "./platform.js";

type ApiState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; api: TavroApi }
  | { status: "error"; message: string };

interface ApiContextValue {
  choice: BackendChoice | null;
  state: ApiState;
  api: TavroApi | null;
  setChoice: (choice: BackendChoice | null) => void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

/** How long Change backend waits for the backend being left to finish closing. */
export const CLOSE_WAIT_MS = 3_000;

export function ApiProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<BackendChoice | null>(() => loadBackendChoice());
  const [state, setState] = useState<ApiState>(() => (choice ? { status: "loading" } : { status: "none" }));
  const queryClient = useQueryClient();
  // The backend being left. The next one is created only once it has removed
  // its stored sign-in, so no session can outlive the switch.
  const closing = useRef<Promise<void>>(Promise.resolve());
  // The backend created for the current choice. StrictMode (development) runs
  // the effect below twice for one choice; the second run reuses the first
  // run's backend instead of leaving a client nobody closes, still refreshing
  // the stored sign-in and listening to other tabs (security re-check I3).
  const created = useRef<{ choice: BackendChoice; api: Promise<TavroApi> } | null>(null);

  useEffect(() => {
    if (!choice) {
      setState({ status: "none" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    if (created.current?.choice !== choice) created.current = { choice, api: closing.current.then(() => createApi(choice)) };
    created.current.api.then(
      (api) => alive && setState({ status: "ready", api }),
      // Invalid stored settings or a failed chunk download: report, don't crash.
      (e: unknown) =>
        alive &&
        setState({
          status: "error",
          message: e instanceof Error && e.name === "ZodError" ? "The saved connection settings are invalid." : "Could not load the app. Check your connection and retry.",
        }),
    );
    return () => {
      alive = false;
    };
  }, [choice]);

  const value = useMemo<ApiContextValue>(
    () => ({
      choice,
      state,
      api: state.status === "ready" ? state.api : null,
      setChoice: (next) => {
        if (state.status === "ready") {
          const leaving = state.api;
          // close() removes the stored session first (synchronous web storage), then
          // signs out locally; that second step can wait on a refresh against an
          // unreachable project. Per-project keys already stop a session moving
          // between projects, so don't keep the user on "Starting…" for it.
          const closed = closing.current.then(() => leaving.close()).catch(() => undefined);
          closing.current = Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS))]);
        }
        saveBackendChoice(next);
        queryClient.clear();
        setChoiceState(next);
      },
    }),
    [choice, state, queryClient],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiContext(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("ApiProvider missing");
  return ctx;
}

/** The active API; only call below the backend/auth gates. */
export function useApi(): TavroApi {
  const { api } = useApiContext();
  if (!api) throw new Error("No backend selected");
  return api;
}

/** Subscribes to server-pushed changes and refreshes the affected queries. */
export function useLiveUpdates(): void {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      api.subscribe((topic) => {
        if (topic === "hosts") void queryClient.invalidateQueries({ queryKey: ["hosts"] });
        else void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }),
    [api, queryClient],
  );
}
