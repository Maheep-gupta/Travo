// Component tests for Settings (spec 5, 12, 13.3, 18.2): alert preference
// save / discard / failure, every system-notification permission state with a
// stubbed Notification API, the Appearance radios, and an axe smoke check.
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
});
