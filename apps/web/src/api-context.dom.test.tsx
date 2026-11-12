// Backend creation (security re-check follow-ups, G32):
// - I3: StrictMode (development) runs ApiProvider's effect twice; that used to
//   create a second backend nobody closed, still refreshing the stored sign-in.
// - L2: a new backend removes stored sign-ins of projects this device has left;
//   demo mode keeps none.
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApiContext } from "./api-context.js";
import { createApi, webStorage } from "./platform.js";

const creations = vi.hoisted(() => ({ count: 0 }));

// The real createApi (demo backend), counted.
vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: (choice: Parameters<typeof actual.createApi>[0]) => {
      creations.count += 1;
      return actual.createApi(choice);
    },
  };
});

function Status() {
  const { state } = useApiContext();
  return <output data-testid="state">{state.status}</output>;
}

let queryClient: QueryClient;

beforeEach(() => {
  window.localStorage.clear();
  creations.count = 0;
  queryClient = new QueryClient();
});

afterEach(() => {
  queryClient.clear();
});

describe("ApiProvider under StrictMode (I3)", () => {
  it("creates one backend for one choice, so no second client is left running", async () => {
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ApiProvider>
            <Status />
          </ApiProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("ready"));
    expect(creations.count).toBe(1);
  });
});

describe("stored sign-ins of projects left behind (L2)", () => {
  it("demo mode removes every project's stored sign-in and nothing else", async () => {
    const x = "tavro.auth:https://project-x.supabase.co";
    window.localStorage.setItem(x, '{"access_token":"x"}');
    window.localStorage.setItem(`${x}-user`, "{}");
    window.localStorage.setItem("tavro.auth:https://project-y.supabase.co", '{"access_token":"y"}');
    window.localStorage.setItem("mc.backend", '{"kind":"demo"}');
    await createApi({ kind: "demo" });
    expect(Object.keys(window.localStorage).sort()).toEqual(["mc.backend"]);
  });

  it("lists web storage keys for the sweep", () => {
    window.localStorage.setItem("a", "1");
    window.localStorage.setItem("b", "2");
    expect([...(webStorage.keys?.() as readonly string[])].sort()).toEqual(["a", "b"]);
  });
});
