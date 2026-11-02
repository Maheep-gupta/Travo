// Component tests for the first-run setup page (spec 9, 13.3, 18.2): field
// errors tied to their inputs, focus on the first invalid field, rejection of
// privileged keys before anything is stored, and the demo entry point.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi } from "@mc/api-client/demo";
import { ApiProvider, useApiContext } from "../api-context.js";
import { SetupPage } from "./SetupPage.js";

// First run: nothing chosen yet. Demo opens the real demo backend; a Supabase
// project is never contacted from tests.
vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => null,
    createApi: (choice: { kind: string }) =>
      choice.kind === "demo" ? Promise.resolve(createDemoApi({ tickMs: 0 })) : Promise.reject(new Error("no network in tests")),
  };
});

// jsdom has no layout or computed colours, so axe cannot judge contrast here.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const BACKEND_KEY = "mc.backend";
const PUBLISHABLE = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
/** Legacy JWT-style key whose payload says role service_role (signature irrelevant). */
const SERVICE_ROLE_JWT = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role: "service_role", iss: "supabase" })).replace(/=+$/, "")}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => queryClient.clear());

/** Shows what the setup page asked the app to do. */
function ChoiceProbe() {
  const { choice, state } = useApiContext();
  return <output data-testid="choice">{`${choice?.kind ?? "none"}/${state.status}`}</output>;
}

function renderSetup() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <SetupPage />
        <ChoiceProbe />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

// Names are exact now (see the regression test below); prefix matches are kept for robustness.
const urlInput = () => screen.getByRole("textbox", { name: /^Project URL/ }) as HTMLInputElement;
const keyInput = () => screen.getByRole("textbox", { name: /^Publishable key/ }) as HTMLInputElement;
const connect = () => fireEvent.click(screen.getByRole("button", { name: "Connect" }));
const choice = () => screen.getByTestId("choice").textContent;

/** The text of every element an input's aria-describedby points at. */
function description(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`)
    .join(" | ");
}

describe("SetupPage", () => {
  it("starts with no errors and the key hint as the key's description", () => {
    renderSetup();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(urlInput().getAttribute("aria-invalid")).toBeNull();
    expect(keyInput().getAttribute("aria-invalid")).toBeNull();
    expect(urlInput().getAttribute("aria-describedby")).toBeNull();
    expect(description(keyInput())).toBe("Never paste a secret or service-role key. This app rejects them.");
  });

  it("marks an empty key invalid, links its message and focuses it", () => {
    renderSetup();
    connect();
    expect(keyInput().getAttribute("aria-invalid")).toBe("true");
    expect(description(keyInput())).toBe("Never paste a secret or service-role key. This app rejects them. | That does not look like a Supabase key.");
    expect(document.activeElement).toBe(keyInput());
    // The default local URL is valid and stays unmarked.
    expect(urlInput().getAttribute("aria-invalid")).toBeNull();
    expect(choice()).toBe("none/none");
    expect(window.localStorage.getItem(BACKEND_KEY)).toBeNull();
  });

  it("focuses the first invalid field in form order when both are wrong", () => {
    renderSetup();
    fireEvent.change(urlInput(), { target: { value: "http://example.com" } });
    connect();
    expect(urlInput().getAttribute("aria-invalid")).toBe("true");
    expect(keyInput().getAttribute("aria-invalid")).toBe("true");
    expect(description(urlInput())).toBe("Use https:// (http:// is allowed only for a local Supabase on this machine).");
    expect(document.activeElement).toBe(urlInput());
  });

  it("rejects a malformed URL", () => {
    renderSetup();
    fireEvent.change(urlInput(), { target: { value: "not a url" } });
    fireEvent.change(keyInput(), { target: { value: PUBLISHABLE } });
    connect();
    expect(urlInput().getAttribute("aria-invalid")).toBe("true");
    expect(keyInput().getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(urlInput());
    expect(window.localStorage.getItem(BACKEND_KEY)).toBeNull();
  });

  it.each([
    ["a new-style secret key", "sb_secret_abcdefghijklmnopqrstuvwxyz"],
    ["a legacy service_role JWT", SERVICE_ROLE_JWT],
  ])("rejects %s and never stores it", (_name, key) => {
    renderSetup();
    fireEvent.change(keyInput(), { target: { value: key } });
    connect();
    expect(keyInput().getAttribute("aria-invalid")).toBe("true");
    expect(description(keyInput())).toContain("This is a secret / service-role key. Never paste it into a browser or app");
    expect(document.activeElement).toBe(keyInput());
    expect(choice()).toBe("none/none");
    expect(window.localStorage.getItem(BACKEND_KEY)).toBeNull();
    expect(JSON.stringify(window.localStorage)).not.toContain(key);
  });

  it("clears errors and saves the connection once the input is valid", async () => {
    renderSetup();
    connect();
    expect(keyInput().getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(keyInput(), { target: { value: `  ${PUBLISHABLE}  ` } });
    connect();
    expect(keyInput().getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("That does not look like a Supabase key.")).toBeNull();
    // Stored trimmed, exactly as validated.
    expect(JSON.parse(window.localStorage.getItem(BACKEND_KEY) ?? "null")).toEqual({
      kind: "supabase",
      config: { url: "http://127.0.0.1:54321", publishableKey: PUBLISHABLE },
    });
    await waitFor(() => expect(choice()).toMatch(/^supabase\//));
  });

  it("explains what Tavro does, stores and can't do before anything is connected (spec 11.1)", () => {
    renderSetup();
    const about = screen.getByRole("region", { name: "Before you start" });
    const terms = within(about).getAllByRole("term").map((t) => t.textContent);
    expect(terms).toEqual(["What it does", "What it stores, and where", "What it can't do", "Demo mode"]);
    const text = about.textContent ?? "";
    expect(text).toContain("A Supabase project you own holds each session");
    expect(text).toContain("which alert types you want");
    expect(text).toContain("Alert history and this device's preferences stay in this browser");
    expect(text).toContain("No replies, resume or remote approvals");
    expect(text).toContain("never contain transcript text");
    expect(text).toContain("only arrive while Tavro is open");
    expect(text).toContain("Nothing is sent anywhere");
    // It comes before both ways in, and changes nothing by being read.
    const demoCard = screen.getByRole("region", { name: "Explore with demo data" });
    expect(about.compareDocumentPosition(demoCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(choice()).toBe("none/none");
  });

  it("opens demo mode from the demo card", async () => {
    renderSetup();
    const card = screen.getByRole("region", { name: "Explore with demo data" });
    fireEvent.click(within(card).getByRole("button", { name: "Open demo" }));
    expect(JSON.parse(window.localStorage.getItem(BACKEND_KEY) ?? "null")).toEqual({ kind: "demo" });
    await waitFor(() => expect(choice()).toBe("demo/ready"));
  });

  // Regression: each <label className="field"> wraps the hint and error spans,
  // which used to leak into the input's accessible name so screen readers read
  // them twice. Inputs are now named by aria-labelledby on the label span.
  it("names each input by its label only, with hints and errors as descriptions", () => {
    renderSetup();
    fireEvent.change(urlInput(), { target: { value: "ftp://x" } });
    connect();
    expect(screen.getByRole("textbox", { name: "Project URL" })).toBe(urlInput());
    expect(screen.getByRole("textbox", { name: "Publishable key" })).toBe(keyInput());
  });

  it("has no axe violations, before and after a rejected submit", async () => {
    const { container } = renderSetup();
    expect(await axe(container)).toHaveNoViolations();
    connect();
    fireEvent.change(urlInput(), { target: { value: "ftp://x" } });
    connect();
    expect(await axe(container)).toHaveNoViolations();
  });
});
