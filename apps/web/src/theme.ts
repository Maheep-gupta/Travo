// Appearance: System (default), Dark or Light, stored per device.
//
// System sets no attribute and lets the CSS media query follow the OS, so the
// default needs no JavaScript to avoid a flash. An explicit choice sets
// data-theme on <html>, which styles.css lets override the media query. The
// inline script in index.html applies a stored choice before first paint;
// main.tsx re-applies it here (theme-color, color-scheme) before React renders.
import type { KeyValueStorage } from "@mc/api-client/demo";

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "dark", "light"];

/** Must match the inline script in index.html. */
export const THEME_STORAGE_KEY = "tavro.theme.v1";

/** Browser chrome colours; equal to --bg / --light-bg in styles.css and the metas in index.html. */
export const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = { dark: "#111412", light: "#f5f2eb" };

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Anything other than an explicit "dark" or "light" means System. */
export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === "dark" || raw === "light" ? raw : "system";
}

export function loadThemePreference(storage: KeyValueStorage): ThemePreference {
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** System is stored as "no value", so clearing storage and choosing System are the same thing. */
export function saveThemePreference(storage: KeyValueStorage, pref: ThemePreference): void {
  try {
    void (pref === "system" ? storage.removeItem(THEME_STORAGE_KEY) : storage.setItem(THEME_STORAGE_KEY, pref));
  } catch {
    // Blocked storage: the choice lasts for this visit only.
  }
}

export function resolveTheme(pref: ThemePreference, systemIsLight: boolean): ResolvedTheme {
  if (pref !== "system") return pref;
  return systemIsLight ? "light" : "dark";
}

/** The subset of matchMedia we use; injectable for tests. */
export type MatchMedia = (query: string) => {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

function browserMatchMedia(): MatchMedia | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? (q) => window.matchMedia(q) : null;
}

/** False (dark, the default palette) when the browser cannot tell us. */
export function systemPrefersLight(matchMedia: MatchMedia | null = browserMatchMedia()): boolean {
  try {
    return matchMedia?.(LIGHT_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** Calls `onChange` when the OS switches between light and dark. Returns the unsubscribe function. */
export function subscribeSystemTheme(onChange: () => void, matchMedia: MatchMedia | null = browserMatchMedia()): () => void {
  try {
    const mq = matchMedia?.(LIGHT_QUERY);
    if (!mq) return () => {};
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}

interface ThemeElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The parts of Document we touch; a real `document` satisfies it. */
export interface ThemeDocument {
  readonly documentElement: ThemeElement;
  querySelectorAll(selector: string): Iterable<ThemeElement>;
}

/**
 * Applies a preference to <html> and the head metas. With System the
 * media-query metas carry their own colours; with an explicit choice both are
 * set to that theme's colour, because the media query no longer decides.
 */
export function applyThemePreference(pref: ThemePreference, doc: ThemeDocument): void {
  const root = doc.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);

  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
    const forLight = (meta.getAttribute("media") ?? "").includes("light");
    meta.setAttribute("content", THEME_COLORS[pref === "system" ? (forLight ? "light" : "dark") : pref]);
  }
  for (const meta of doc.querySelectorAll('meta[name="color-scheme"]')) {
    meta.setAttribute("content", pref === "system" ? "dark light" : pref);
  }
}
