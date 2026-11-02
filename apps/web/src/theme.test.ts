import { describe, expect, it } from "vitest";
import { MemoryStorage, type KeyValueStorage } from "@mc/api-client/demo";
import {
  THEME_COLORS,
  THEME_STORAGE_KEY,
  applyThemePreference,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  subscribeSystemTheme,
  systemPrefersLight,
  type MatchMedia,
  type ThemeDocument,
} from "./theme.js";

class FakeElement {
  readonly attrs = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.attrs.set(k, v);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}

/** The head as shipped in index.html. */
function fakeDocument() {
  const root = new FakeElement();
  const lightMeta = new FakeElement({ name: "theme-color", content: "#f5f2eb", media: "(prefers-color-scheme: light)" });
  const darkMeta = new FakeElement({ name: "theme-color", content: "#111412", media: "(prefers-color-scheme: dark)" });
  const scheme = new FakeElement({ name: "color-scheme", content: "dark light" });
  const doc: ThemeDocument = {
    documentElement: root,
    querySelectorAll: (selector) =>
      selector === 'meta[name="theme-color"]' ? [lightMeta, darkMeta] : selector === 'meta[name="color-scheme"]' ? [scheme] : [],
  };
  return { doc, root, lightMeta, darkMeta, scheme };
}

const throwing: KeyValueStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("parseThemePreference", () => {
  it("accepts only explicit dark or light", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
  });

  it("treats anything else as System", () => {
    for (const raw of [null, undefined, "", "system", "Dark", " light", "auto", 1, {}, Promise.resolve("dark")]) {
      expect(parseThemePreference(raw)).toBe("system");
    }
  });
});

describe("theme storage", () => {
  it("defaults to System and round-trips an explicit choice", () => {
    const storage = new MemoryStorage();
    expect(loadThemePreference(storage)).toBe("system");
    saveThemePreference(storage, "light");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(loadThemePreference(storage)).toBe("light");
  });

  it("stores System as no value", () => {
    const storage = new MemoryStorage();
    saveThemePreference(storage, "dark");
    saveThemePreference(storage, "system");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(loadThemePreference(storage)).toBe("system");
  });

  it("falls back to System on a corrupt value", () => {
    const storage = new MemoryStorage();
    storage.setItem(THEME_STORAGE_KEY, '{"theme":"dark"}');
    expect(loadThemePreference(storage)).toBe("system");
  });

  it("survives blocked storage", () => {
    expect(loadThemePreference(throwing)).toBe("system");
    expect(() => saveThemePreference(throwing, "light")).not.toThrow();
    expect(() => saveThemePreference(throwing, "system")).not.toThrow();
  });
});

describe("resolveTheme and the OS preference", () => {
  it("resolves System from the OS and honours an explicit choice", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("reads and follows matchMedia", () => {
    let matches = true;
    const listeners = new Set<() => void>();
    const mm: MatchMedia = (query) => {
      expect(query).toBe("(prefers-color-scheme: light)");
      return {
        get matches() {
          return matches;
        },
        addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
        removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn),
      };
    };
    expect(systemPrefersLight(mm)).toBe(true);
    let calls = 0;
    const off = subscribeSystemTheme(() => calls++, mm);
    matches = false;
    for (const fn of listeners) fn();
    expect(calls).toBe(1);
    expect(systemPrefersLight(mm)).toBe(false);
    off();
    expect(listeners.size).toBe(0);
  });

  it("assumes dark when matchMedia is missing or throws", () => {
    const broken: MatchMedia = () => {
      throw new Error("nope");
    };
    expect(systemPrefersLight(null)).toBe(false);
    expect(systemPrefersLight(broken)).toBe(false);
    expect(() => subscribeSystemTheme(() => {}, null)()).not.toThrow();
    expect(() => subscribeSystemTheme(() => {}, broken)()).not.toThrow();
  });
});

describe("applyThemePreference", () => {
  it("forces a theme on <html> and both theme-color metas", () => {
    const { doc, root, lightMeta, darkMeta, scheme } = fakeDocument();
    applyThemePreference("light", doc);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(lightMeta.getAttribute("content")).toBe(THEME_COLORS.light);
    expect(darkMeta.getAttribute("content")).toBe(THEME_COLORS.light);
    expect(scheme.getAttribute("content")).toBe("light");

    applyThemePreference("dark", doc);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(lightMeta.getAttribute("content")).toBe(THEME_COLORS.dark);
    expect(darkMeta.getAttribute("content")).toBe(THEME_COLORS.dark);
    expect(scheme.getAttribute("content")).toBe("dark");
  });

  it("restores the media-query defaults for System", () => {
    const { doc, root, lightMeta, darkMeta, scheme } = fakeDocument();
    applyThemePreference("dark", doc);
    applyThemePreference("system", doc);
    expect(root.getAttribute("data-theme")).toBeNull();
    expect(lightMeta.getAttribute("content")).toBe("#f5f2eb");
    expect(darkMeta.getAttribute("content")).toBe("#111412");
    expect(scheme.getAttribute("content")).toBe("dark light");
  });
});
