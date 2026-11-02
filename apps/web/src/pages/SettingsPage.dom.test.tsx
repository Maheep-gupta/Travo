// Component tests for Settings (spec 5, 12, 13.3, 18.2): alert preference
// save / discard / failure, every system-notification permission state with a
// stubbed Notification API, the Appearance radios, the Account, Privacy,
// Integrations and Application sections (spec 10.2, 12, 14.1), and axe checks.
import { ApiError } from "@mc/api-client/demo";
import { useEffect, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import { createDemoApi, type AuthUser, type TavroApi } from "@mc/api-client/demo";
import type { NotificationPrefs } from "@mc/contracts";
import { DEFAULT_NOTIFICATION_PREFS } from "@mc/contracts/constants";
import { AlertsProvider } from "../alerts-context.js";
import { ApiProvider, useApiContext } from "../api-context.js";
import { APP_VERSION } from "../app-info.js";
import { THEME_STORAGE_KEY } from "../theme.js";
import { SettingsPage } from "./SettingsPage.js";

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

const SYSTEM_NOTIFICATIONS_KEY = "tavro.systemNotifications.v1";

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
let demo: TavroApi;

beforeEach(() => {
  demo = createDemoApi({ tickMs: 0 });
  backend.api = demo;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  backend.api = null;
  document.documentElement.removeAttribute("data-theme");
});

/** Like the auth gate in App: the signed-in user boundary once the backend is up. */
function SignedIn({ children }: { children: ReactNode }) {
  const { api } = useApiContext();
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    if (api) void api.getUser().then(setUser);
  }, [api]);
  return api && user ? <AlertsProvider userId={user.id}>{children}</AlertsProvider> : <p>Starting test backend</p>;
}

async function renderSettings() {
  const view = render(
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
  await screen.findByRole("heading", { level: 1, name: "Preferences & connection" }, { timeout: 5000 });
  return view;
}

const alertsCard = () => screen.getByRole("form", { name: "Alerts" });
const toggle = (name: string) => within(alertsCard()).getByRole("switch", { name }) as HTMLInputElement;
const saveButton = () => within(alertsCard()).getByRole("button", { name: /^Sav(e preferences|ing…)$/ }) as HTMLButtonElement;
const alertsStatus = () => (within(alertsCard()).getByRole("status").textContent ?? "").trim();

async function prefsLoaded() {
  await within(await screen.findByRole("form", { name: "Alerts" }, { timeout: 5000 })).findAllByRole("switch");
}

describe("Settings: alert preferences", () => {
  it("shows the defaults, then tracks unsaved changes field by field", async () => {
    await renderSettings();
    await prefsLoaded();
    expect(toggle("Completed").checked).toBe(DEFAULT_NOTIFICATION_PREFS.on_completed);
    expect(toggle("Host reconnected").checked).toBe(DEFAULT_NOTIFICATION_PREFS.on_host_reconnected);
    expect(saveButton().disabled).toBe(true);
    expect(alertsStatus()).toBe("");

    fireEvent.click(toggle("Completed"));
    expect(toggle("Completed").checked).toBe(false);
    expect(saveButton().disabled).toBe(false);
    expect(alertsStatus()).toBe("Unsaved changes");

    // Flipping it back is no change, not a pending save.
    fireEvent.click(toggle("Completed"));
    expect(saveButton().disabled).toBe(true);
    expect(alertsStatus()).toBe("");
    expect(within(alertsCard()).queryByRole("button", { name: "Discard changes" })).toBeNull();
  });

  it("saves to the backend, confirms, and the saved values survive a reload", async () => {
    const { unmount } = await renderSettings();
    await prefsLoaded();
    fireEvent.click(toggle("Failed"));
    fireEvent.click(saveButton());

    await waitFor(() => expect(alertsStatus()).toBe("Saved"));
    expect(saveButton().disabled).toBe(true);
    expect((await demo.getNotificationPrefs())?.on_failed).toBe(false);

    unmount();
    queryClient.clear();
    await renderSettings();
    await prefsLoaded();
    expect(toggle("Failed").checked).toBe(false);
    expect(alertsStatus()).toBe("");
  });

  it("discards unsaved changes without saving", async () => {
    const save = vi.spyOn(demo, "saveNotificationPrefs");
    await renderSettings();
    await prefsLoaded();
    fireEvent.click(toggle("Needs approval"));
    fireEvent.click(toggle("Host reconnected"));
    fireEvent.click(within(alertsCard()).getByRole("button", { name: "Discard changes" }));

    expect(toggle("Needs approval").checked).toBe(true);
    expect(toggle("Host reconnected").checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(alertsStatus()).toBe("");
    expect(save).not.toHaveBeenCalled();
  });

  it("disables the form while saving", async () => {
    const pending = deferred<undefined>();
    backend.api = { ...demo, saveNotificationPrefs: () => pending.promise };
    await renderSettings();
    await prefsLoaded();
    fireEvent.click(toggle("Completed"));
    fireEvent.click(saveButton());

    await waitFor(() => expect(saveButton().textContent).toBe("Saving…"));
    expect(saveButton().disabled).toBe(true);
    expect(toggle("Completed").disabled).toBe(true);
    expect(within(alertsCard()).queryByRole("button", { name: "Discard changes" })).toBeNull();

    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(alertsStatus()).toBe("Saved"));
    expect(toggle("Completed").disabled).toBe(false);
  });

  it("keeps the edit and shows the error when saving fails, then saves on retry", async () => {
    let fail = true;
    backend.api = {
      ...demo,
      saveNotificationPrefs: (p: NotificationPrefs) => (fail ? Promise.reject(new ApiError("Could not save preferences", "unavailable")) : demo.saveNotificationPrefs(p)),
    };
    await renderSettings();
    await prefsLoaded();
    fireEvent.click(toggle("Completed"));
    fireEvent.click(saveButton());

    const error = await within(alertsCard()).findByRole("alert");
    expect(error.textContent).toContain("Could not save preferences");
    expect(toggle("Completed").checked).toBe(false);
    expect(alertsStatus()).toBe("Unsaved changes");
    expect(saveButton().disabled).toBe(false);

    fail = false;
    fireEvent.click(saveButton());
    await waitFor(() => expect(alertsStatus()).toBe("Saved"));
    expect(within(alertsCard()).queryByRole("alert")).toBeNull();
  });

  it("explains a failed load with a retry instead of showing defaults", async () => {
    let fail = true;
    backend.api = { ...demo, getNotificationPrefs: () => (fail ? Promise.reject(new ApiError("Preferences unavailable", "unavailable")) : demo.getNotificationPrefs()) };
    await renderSettings();
    const card = screen.getByRole("heading", { level: 2, name: "Alerts" }).closest("section") as HTMLElement;
    const error = await within(card).findByRole("alert", {}, { timeout: 5000 });
    expect(error.textContent).toContain("Preferences unavailable");
    expect(within(card).queryAllByRole("switch")).toHaveLength(0);

    fail = false;
    fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
    await prefsLoaded();
  });
});

describe("Settings: system notifications", () => {
  /** A stand-in for the browser Notification API; the test drives permission. */
  function stubNotifications(permission: NotificationPermission, onRequest: () => NotificationPermission | Promise<NotificationPermission> = () => permission) {
    const created: { title: string; options?: NotificationOptions }[] = [];
    class FakeNotification {
      static permission = permission;
      static refuse = false;
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = await onRequest();
        return FakeNotification.permission;
      });
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        // Android Chrome throws here for page-created notifications.
        if (FakeNotification.refuse) throw new TypeError("Illegal constructor");
        created.push({ title, options });
      }
      close() {
        this.onclose?.();
      }
    }
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: FakeNotification });
    return { Fake: FakeNotification, created };
  }

  afterEach(() => {
    delete (window as { Notification?: unknown }).Notification;
    delete (window as { isSecureContext?: unknown }).isSecureContext;
  });

  const card = () => screen.getByRole("heading", { level: 2, name: "System notifications on this device" }).closest("section") as HTMLElement;
  const deviceSwitch = () => within(card()).queryByRole("switch", { name: "Notify me on this device" }) as HTMLInputElement | null;

  it("explains when the browser has no Notification API, and offers nothing to click", async () => {
    await renderSettings();
    expect(within(card()).getByText(/doesn.t offer notifications to web pages here/)).toBeTruthy();
    expect(within(card()).queryByRole("button")).toBeNull();
    expect(deviceSwitch()).toBeNull();
  });

  it("asks for permission only on click and turns on when granted", async () => {
    const { Fake, created } = stubNotifications("default", () => "granted");
    await renderSettings();
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    expect(within(card()).getByText("Your browser will ask for permission.")).toBeTruthy();

    fireEvent.click(within(card()).getByRole("button", { name: "Turn on system notifications" }));
    await waitFor(() => expect(deviceSwitch()?.checked).toBe(true));
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SYSTEM_NOTIFICATIONS_KEY)).toBe("on");

    fireEvent.click(within(card()).getByRole("button", { name: "Send a test notification" }));
    expect(created).toHaveLength(1);
    // Generic and non-identifying: no session or host names, no ids in the tag.
    expect(created[0]?.options?.tag).toBe("tavro:waiting_for_input");
    expect(within(card()).getByRole("status").textContent).toMatch(/^Sent\./);
  });

  it("shows a busy button while the browser prompt is open", async () => {
    const answer = deferred<NotificationPermission>();
    stubNotifications("default", () => answer.promise);
    await renderSettings();
    fireEvent.click(within(card()).getByRole("button", { name: "Turn on system notifications" }));
    const busy = await within(card()).findByRole("button", { name: "Waiting for your browser…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer.resolve("granted"));
    await waitFor(() => expect(deviceSwitch()?.checked).toBe(true));
  });

  it("supports the old callback-only requestPermission (Safari)", async () => {
    const { Fake } = stubNotifications("default");
    Fake.requestPermission = vi.fn((cb?: (p: NotificationPermission) => void) => {
      Fake.permission = "granted";
      cb?.("granted");
      return undefined;
    }) as unknown as typeof Fake.requestPermission;
    await renderSettings();
    fireEvent.click(within(card()).getByRole("button", { name: "Turn on system notifications" }));
    await waitFor(() => expect(deviceSwitch()?.checked).toBe(true));
  });

  it("explains how to unblock when the user denies the prompt, and stays off", async () => {
    stubNotifications("default", () => "denied");
    await renderSettings();
    fireEvent.click(within(card()).getByRole("button", { name: "Turn on system notifications" }));
    expect(await within(card()).findByText(/Notifications are blocked for this site/)).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Turn on system notifications" })).toBeNull();
    expect(deviceSwitch()).toBeNull();
    expect(window.localStorage.getItem(SYSTEM_NOTIFICATIONS_KEY)).toBeNull();
  });

  it("explains an already blocked permission without offering to ask", async () => {
    const { Fake } = stubNotifications("denied");
    await renderSettings();
    expect(within(card()).getByText(/Tavro won.t ask again on its own/)).toBeTruthy();
    expect(within(card()).queryByRole("button")).toBeNull();
    expect(Fake.requestPermission).not.toHaveBeenCalled();
  });

  it("keeps the device switch separate from the permission and remembers it", async () => {
    stubNotifications("granted");
    window.localStorage.setItem(SYSTEM_NOTIFICATIONS_KEY, "on");
    await renderSettings();
    expect(deviceSwitch()?.checked).toBe(true);

    fireEvent.click(deviceSwitch() as HTMLInputElement);
    expect(deviceSwitch()?.checked).toBe(false);
    expect(window.localStorage.getItem(SYSTEM_NOTIFICATIONS_KEY)).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Send a test notification" })).toBeNull();
  });

  it("says so when the browser refuses to show a notification, and clears once one works", async () => {
    const { Fake, created } = stubNotifications("granted");
    window.localStorage.setItem(SYSTEM_NOTIFICATIONS_KEY, "on");
    await renderSettings();

    Fake.refuse = true;
    fireEvent.click(within(card()).getByRole("button", { name: "Send a test notification" }));
    const refused = within(card()).getByRole("alert");
    expect(refused.textContent).toContain("This browser refused to show a notification.");
    expect(created).toHaveLength(0);

    // Also resets the module-level failure flag so later tests start clean.
    Fake.refuse = false;
    fireEvent.click(within(card()).getByRole("button", { name: "Send a test notification" }));
    expect(within(card()).queryByRole("alert")).toBeNull();
    expect(created).toHaveLength(1);
  });
});

describe("Settings: appearance", () => {
  const radio = (name: string) => within(screen.getByRole("group", { name: "Theme" })).getByRole("radio", { name }) as HTMLInputElement;

  it("offers System, Dark and Light as one radio group and applies the choice", async () => {
    await renderSettings();
    const group = screen.getByRole("group", { name: "Theme" });
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["system", "dark", "light"]);
    expect(radio("System").checked).toBe(true);

    fireEvent.click(radio("Light"));
    expect(radio("Light").checked).toBe(true);
    expect(radio("System").checked).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("follows a theme change made in another tab", async () => {
    await renderSettings();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }));
    });
    expect(radio("Dark").checked).toBe(true);

    // Storage cleared elsewhere (key null): back to System.
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    });
    expect(radio("System").checked).toBe(true);
  });
});

describe("Settings: accessibility", () => {
  it("has no axe violations with preferences loaded and unsaved changes", async () => {
    const { container } = await renderSettings();
    await prefsLoaded();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(toggle("Completed"));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations with the clear-data confirmation open", async () => {
    const { container } = await renderSettings();
    await prefsLoaded();
    fireEvent.click(within(section("Privacy & data")).getByRole("button", { name: "Clear this account's data on this device…" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("Settings: account", () => {
  it("shows the demo account and backend, with Change backend but no dead Sign out", async () => {
    await renderSettings();
    const card = section("Account");
    expect(within(card).getByText("Demo user, no sign-in needed")).toBeTruthy();
    expect(within(card).getByText("Demo, in this browser only")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Change backend" })).toBeTruthy();
  });

  it("shows the signed-in email for a Supabase account and signs out", async () => {
    const signOut = vi.fn(() => Promise.resolve({ serverRevoked: true }));
    backend.api = { ...demo, kind: "supabase", getUser: () => demo.getUser().then((u) => u && { ...u, email: "dev@example.com" }), signOut };
    await renderSettings();
    const card = section("Account");
    expect(await within(card).findByText("dev@example.com")).toBeTruthy();
    expect(within(card).getByText("Your own Supabase project")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("says so when signing out fails, and lets the user retry", async () => {
    backend.api = { ...demo, kind: "supabase", signOut: () => Promise.reject(new Error("network")) };
    await renderSettings();
    const card = section("Account");
    fireEvent.click(within(card).getByRole("button", { name: "Sign out" }));
    expect((await within(card).findByRole("alert")).textContent).toContain("Couldn't sign out");
    expect((within(card).getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Settings: privacy and data", () => {
  const clearButton = (card: HTMLElement) => within(card).getByRole("button", { name: "Clear this account's data on this device…" });

  it("lists what is stored where, for demo mode", async () => {
    await renderSettings();
    const text = section("Privacy & data").textContent ?? "";
    expect(text).toContain("no servers of its own and no analytics");
    expect(text).toContain("generated in this tab's memory");
    expect(text).toContain("ids, kinds, times and read state. No names or session text.");
    expect(text).toContain("Transcript text is never sent to a remote project");
    expect(text).toContain("without session or host names and without any transcript text");
  });

  it("describes the user's own Supabase project when connected", async () => {
    backend.api = { ...demo, kind: "supabase" };
    await renderSettings();
    const text = section("Privacy & data").textContent ?? "";
    expect(text).toContain("stored in your own Supabase project");
    // Every synced field, as in the sessions and hosts tables.
    expect(text).toContain("title, project label, provider and its session id, status and status reason, last event summary, capabilities");
    expect(text).toContain("name, platform, connector version, the organisation's remote-control policy, heartbeat and session-source health times");
    expect(text).toContain("Which alert types you want.");
    expect(text).toContain("Alert types are saved with your data above, not here.");
    // D-013 isn't approved, so the names opt-in is neither listed nor promised.
    expect(text).not.toContain("whether notifications may include names");
    expect(text).toContain("automated database tests haven't run yet");
    expect(text).toContain("your sign-in session");
  });

  it("asks for confirmation; Cancel keeps everything and returns focus", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await renderSettings();
    const card = section("Privacy & data");
    fireEvent.click(clearButton(card));
    const confirm = within(card).getByRole("group");
    expect(confirm.textContent).toContain("can't be undone");
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(clearButton(card));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("clears alerts and device preferences, and the other cards show the reset", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.localStorage.setItem(SYSTEM_NOTIFICATIONS_KEY, "on");
    await renderSettings();
    const radio = (name: string) => within(screen.getByRole("group", { name: "Theme" })).getByRole("radio", { name }) as HTMLInputElement;
    expect(radio("Dark").checked).toBe(true);
    const user = await demo.getUser();
    const alertKey = `tavro.alerts.v1:demo:${user?.id ?? ""}`;
    window.localStorage.setItem(alertKey, JSON.stringify([{ id: "a1", kind: "failed", sessionId: "s1", hostId: "h1", at: new Date().toISOString(), isDemo: true, read: false }]));

    const card = section("Privacy & data");
    fireEvent.click(clearButton(card));
    fireEvent.click(within(card).getByRole("button", { name: "Clear data" }));

    expect(within(card).getByRole("status").textContent).toContain("Cleared from this device");
    expect(window.localStorage.getItem(alertKey)).toBe("[]");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(SYSTEM_NOTIFICATIONS_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(radio("System").checked).toBe(true);
    // The connection is left to Change backend.
    expect(screen.getByRole("heading", { level: 1, name: "Preferences & connection" })).toBeTruthy();
  });
});

describe("Settings: integrations and application", () => {
  it("lists Claude Code as not enabled yet, with the reason, and offers no control", async () => {
    await renderSettings();
    const card = section("Integrations");
    expect(within(card).getByText("Not enabled yet")).toBeTruthy();
    expect(card.textContent).toContain("stays off until Tavro's database security tests have run and passed");
    expect(card.textContent).toContain("demo simulator");
    expect(within(card).queryByRole("switch")).toBeNull();
    expect(within(card).queryByRole("checkbox")).toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("shows the version, build, install state and install guidance", async () => {
    await renderSettings();
    const card = section("Application");
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(within(card).getByText(APP_VERSION)).toBeTruthy();
    expect(card.textContent).toContain("Running as");
    expect(card.textContent).toContain("Add to Home Screen");
    expect(card.textContent).toContain("Install app");
    expect(card.textContent).toContain("only arrive while Tavro is open");
  });
});
