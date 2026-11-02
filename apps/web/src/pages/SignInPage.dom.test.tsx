// Component tests for the sign-in page (spec 9.1, 13.3, 18.2): the error is
// announced and linked to both inputs, focus returns to the password, and the
// form is busy (and refuses double submits) while a sign-in is in flight.
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { ApiError, createDemoApi, type TavroApi } from "@mc/api-client/demo";
import { ApiProvider, useApiContext } from "../api-context.js";
import { SignInPage } from "./SignInPage.js";

const backend = vi.hoisted(() => ({ api: null as TavroApi | null }));

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    loadBackendChoice: () => ({ kind: "demo" }),
    createApi: () => (backend.api ? Promise.resolve(backend.api) : Promise.reject(new Error("test backend missing"))),
  };
});

// jsdom has no layout or computed colours, so axe cannot judge contrast here.
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

/** A promise the test settles by hand, to hold sign-in "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let queryClient: QueryClient;
let signIn: ReturnType<typeof vi.fn<(email: string, password: string) => Promise<void>>>;

beforeEach(() => {
  const demo = createDemoApi({ tickMs: 0 });
  signIn = vi.fn<(email: string, password: string) => Promise<void>>(() => Promise.resolve());
  // The demo backend is always signed in; only signIn is replaced.
  backend.api = { ...demo, signIn };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
});

function ApiReady({ children }: { children: ReactNode }) {
  const { api, choice } = useApiContext();
  return (
    <>
      <output data-testid="choice">{choice?.kind ?? "none"}</output>
      {api ? children : <p>Starting test backend</p>}
    </>
  );
}

async function renderSignIn(onSignedIn = vi.fn()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <ApiReady>
          <SignInPage onSignedIn={onSignedIn} />
        </ApiReady>
      </ApiProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Sign in" }, { timeout: 5000 });
  return { ...view, onSignedIn };
}

const email = () => screen.getByLabelText("Email") as HTMLInputElement;
const password = () => screen.getByLabelText("Password") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /^Sign(ing)? in/ }) as HTMLButtonElement;

function fillAndSubmit(e = "dev@example.com", p = "correct horse") {
  fireEvent.change(email(), { target: { value: e } });
  fireEvent.change(password(), { target: { value: p } });
  fireEvent.click(submitButton());
}

describe("SignInPage", () => {
  it("signs in and reports the user", async () => {
    const { onSignedIn } = await renderSignIn();
    expect(email().getAttribute("aria-invalid")).toBeNull();
    fillAndSubmit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith("dev@example.com", "correct horse");
    expect(onSignedIn.mock.calls[0]?.[0]).toMatchObject({ id: "00000000-0000-4000-8000-000000000001" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces a rejected sign-in, links it to both inputs and focuses the password", async () => {
    signIn.mockRejectedValueOnce(new ApiError("Invalid login credentials", "invalid"));
    const { onSignedIn } = await renderSignIn();
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Invalid login credentials");
    for (const input of [email(), password()]) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    }
    expect(document.activeElement).toBe(password());
    expect(onSignedIn).not.toHaveBeenCalled();
    // What the user typed is kept for the retry.
    expect(email().value).toBe("dev@example.com");
  });

  it("is busy while signing in, ignores a second submit and clears the old error", async () => {
    signIn.mockRejectedValueOnce(new Error("Invalid login credentials"));
    const { onSignedIn } = await renderSignIn();
    fillAndSubmit();
    await screen.findByRole("alert");

    const pending = deferred<undefined>();
    signIn.mockReturnValueOnce(pending.promise);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().textContent).toBe("Signing in…"));
    expect(submitButton().disabled).toBe(true);
    // The previous error is gone while the new attempt runs.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(email().getAttribute("aria-invalid")).toBeNull();

    // A submit that bypasses the disabled button (Enter key path) is ignored.
    fireEvent.submit(submitButton().closest("form") as HTMLFormElement);
    expect(signIn).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe("Sign in");
  });

  it("returns to backend choice from Change backend", async () => {
    await renderSignIn();
    expect(screen.getByTestId("choice").textContent).toBe("demo");
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    await waitFor(() => expect(screen.getByTestId("choice").textContent).toBe("none"));
  });

  it("has no axe violations, before and after a rejected sign-in", async () => {
    signIn.mockRejectedValueOnce(new Error("Invalid login credentials"));
    const { container } = await renderSignIn();
    expect(await axe(container)).toHaveNoViolations();
    fillAndSubmit();
    await screen.findByRole("alert");
    expect(await axe(container)).toHaveNoViolations();
  });
});
