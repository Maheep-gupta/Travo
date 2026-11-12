// Settings > Diagnostics (spec Part 12, area 10): "Copy report" with the
// Clipboard API, the select-the-text fallback when it is missing or refused,
// and that the copied text leaves out names, titles and user ids.
import { useEffect, useState, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type AuthUser, type TavroApi } from "@mc/api-client/demo";
import { AlertsProvider } from "./alerts-context.js";
import { ApiProvider, useApiContext } from "./api-context.js";
import { SettingsPage } from "./pages/SettingsPage.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("./platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

let queryClient: QueryClient;
let user: AuthUser | null = null;

function SignedIn({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  const [u, setU] = useState<AuthUser | null>(null);
  useEffect(() => {
    if (api) void api.getUser().then(setU);
  }, [api]);
  user = u;
  return api && u ? <AlertsProvider userId={u.id}>{children}</AlertsProvider> : <p>Starting test backend</p>;
}

async function renderDiagnostics() {
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <MemoryRouter initialEntries={["/settings"]}>
          <SignedIn>
            <SettingsPage />
          </SignedIn>
        </MemoryRouter>
      </ApiProvider>
    </QueryClientProvider>,
  );
  const card = (await screen.findByRole("heading", { name: "Diagnostics" }, { timeout: 5000 })).closest("section") as HTMLElement;
  // Hosts, sessions, schema and alert types loaded, so the report has them.
  await waitFor(() => expect(within(card).queryByText(/still loading/)).toBeNull(), { timeout: 5000 });
  return card;
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  backend.api = createDemoApi({ tickMs: 0 });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
  setClipboard(undefined);
  localStorage.clear();
});

describe("Settings diagnostics", () => {
  it("copies a report without names, titles or user ids", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    setClipboard({ writeText });
    const card = await renderDiagnostics();
    // A key holding a user id, as the alert store writes.
    localStorage.setItem(`tavro.alerts.v1:demo:${user?.id ?? "x"}`, "[]");

    fireEvent.click(within(card).getByRole("button", { name: "Copy report" }));
    expect(await within(card).findByText("Copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("Tavro diagnostics report");
    expect(text).toContain("Kind: demo (simulated, in this browser)");
    expect(text).toMatch(/Host 1: online; platform simulated; connector demo/);
    expect(text).toMatch(/Host 2: disconnected/);
    expect(text).toContain("tavro.alerts.v1");
    for (const leak of ["Demo laptop", "Demo desktop", "Nightly data import", "demo@example.invalid", user?.id ?? "no user"]) {
      expect(text).not.toContain(leak);
    }
    // The copied text is also shown, for the user to check.
    expect((within(card).getByRole("textbox", { name: "Diagnostics report" }) as HTMLTextAreaElement).value).toBe(text);
  });

  it("falls back to selected text when the Clipboard API is missing", async () => {
    setClipboard(undefined);
    const card = await renderDiagnostics();
    fireEvent.click(within(card).getByRole("button", { name: "Copy report" }));
    expect(await within(card).findByText(/Couldn't copy automatically/)).toBeTruthy();
    const box = within(card).getByRole("textbox", { name: "Diagnostics report" }) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(box.value).toContain("Tavro diagnostics report");
    await waitFor(() => expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]));
  });

  it("falls back the same way when the browser refuses the copy", async () => {
    setClipboard({ writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    const card = await renderDiagnostics();
    fireEvent.click(within(card).getByRole("button", { name: "Copy report" }));
    expect(await within(card).findByText(/Couldn't copy automatically/)).toBeTruthy();
    expect(within(card).queryByText("Copied")).toBeNull();
  });

  it("shows the report on request and has no axe violations", async () => {
    const card = await renderDiagnostics();
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Show report" }));
    const box = (await within(card).findByRole("textbox", { name: "Diagnostics report" })) as HTMLTextAreaElement;
    expect(box.value).toContain("Sessions: ");
    expect(within(card).getByRole("button", { name: "Refresh report" })).toBeTruthy();
    expect(await axe(card)).toHaveNoViolations();
  });
});
