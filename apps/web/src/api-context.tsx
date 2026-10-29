import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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

export function ApiProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<BackendChoice | null>(() => loadBackendChoice());
  const [state, setState] = useState<ApiState>(() => (choice ? { status: "loading" } : { status: "none" }));
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!choice) {
      setState({ status: "none" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    createApi(choice).then(
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
