// Component tests for Appearance: the Settings radio group and the
// pre-paint script loaded by index.html.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import themeInit from "../public/theme-init.js?raw";
import indexHtml from "../index.html?raw";
import { AppearanceCard } from "./pages/SettingsPage.js";
import { THEME_COLORS, THEME_STORAGE_KEY } from "./theme.js";

const HEAD = `
  <meta name="theme-color" content="#f5f2eb" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#111412" media="(prefers-color-scheme: dark)" />
  <meta name="color-scheme" content="dark light" />`;

function themeColors(): (string | null)[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));
}

beforeEach(() => {
  document.head.innerHTML = HEAD;
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
});

describe("Appearance setting", () => {
  it("defaults to System with no data-theme", () => {
    render(<AppearanceCard />);
    const group = screen.getByRole("group", { name: "Theme" });
    expect(group).toBeTruthy();
    expect((screen.getByRole("radio", { name: "System" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    // jsdom has no matchMedia, so System resolves to the dark default.
    expect(screen.getByText("Match this device, currently Dark")).toBeTruthy();
  });

  it("applies, stores and clears an explicit choice", () => {
    render(<AppearanceCard />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(themeColors()).toEqual([THEME_COLORS.light, THEME_COLORS.light]);

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeColors()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);

    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(themeColors()).toEqual(["#f5f2eb", "#111412"]);
  });

  it("shows the stored choice", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<AppearanceCard />);
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("index.html pre-paint script", () => {
  const script = themeInit;
  const run = () => new Function(script)();

  it("is loaded from a same-origin file before the app, with no inline script (strict CSP)", () => {
    expect(indexHtml).toContain('<script src="/theme-init.js"></script>');
    expect(indexHtml.indexOf("/theme-init.js")).toBeLessThan(indexHtml.indexOf("/src/main.tsx"));
    expect(indexHtml).not.toMatch(/<script>/);
  });

  it("uses the same storage key as theme.ts", () => {
    expect(script).toContain(`"${THEME_STORAGE_KEY}"`);
  });

  it("sets data-theme only for a valid explicit choice", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    run();
    expect(document.documentElement.dataset.theme).toBe("light");

    document.documentElement.removeAttribute("data-theme");
    window.localStorage.setItem(THEME_STORAGE_KEY, "<img>");
    run();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
