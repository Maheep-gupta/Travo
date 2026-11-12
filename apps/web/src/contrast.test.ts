// Token contrast (G31, spec 13.3; WCAG 2.2 SC 1.4.3 text, 1.4.11 non-text).
// jsdom has no computed colours, so axe's color-contrast rule is off in the dom
// tests; this checks the design tokens themselves, in both themes, for every
// foreground/background pairing the stylesheets actually use.
//
// What this proves: the token values meet AA where they are combined as listed
// below. What it can't: colours over images, gradients or translucent layers
// whose backdrop depends on scroll position (the top bar and tab bar), text
// rendered at runtime with opacity, and anything a stylesheet combines that is
// not listed here. Those need a real browser (docs/QUALITY.md).
import { describe, expect, it } from "vitest";

// Vitest empties CSS imports (even `?raw`), so read the file from disk. The web
// tsconfig has no Node types (it targets the browser); type just this call
// rather than pulling Node globals into the whole app program.
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: URL, encoding: "utf8") => string };
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

type Rgba = readonly [number, number, number, number];
type Theme = Readonly<Record<string, string>>;

const declarations = (body: string): Record<string, string> =>
  Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));

/** The body of the first rule whose selector matches exactly (no nested braces in these rules). */
function ruleBody(source: string, selector: RegExp): string {
  const m = new RegExp(`${selector.source}\\s*\\{([^{}]*)\\}`).exec(source);
  if (!m?.[1]) throw new Error(`rule ${selector.source} not found in styles.css`);
  return m[1];
}

/**
 * styles.css declares dark on the first `:root`, the light palette as inert
 * `--light-*` tokens on a second `:root`, and maps them onto the live tokens
 * twice (System via prefers-color-scheme, explicit via data-theme="light").
 */
function themes(source: string): { dark: Theme; light: Theme; lightMap: Record<string, string>; systemMap: Record<string, string> } {
  const roots = [...source.matchAll(/(?:^|\n):root\s*\{([^{}]*)\}/g)].map((m) => declarations(m[1] as string));
  const dark = roots.find((r) => "bg" in r);
  const palette = roots.find((r) => "light-bg" in r);
  if (!dark || !palette) throw new Error("dark :root or light palette not found");
  const lightMap = declarations(ruleBody(source, /:root\[data-theme="light"\]/));
  const media = /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([^{}]*)\}/.exec(source);
  if (!media?.[1]) throw new Error("prefers-color-scheme light rule not found");
  const systemMap = declarations(media[1]);
  const light: Record<string, string> = { ...dark };
  for (const [name, value] of Object.entries(lightMap)) {
    const ref = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
    const resolved = ref ? palette[ref] : undefined;
    if (!resolved) throw new Error(`--${name}: ${value} does not resolve to the light palette`);
    light[name] = resolved;
  }
  return { dark, light, lightMap, systemMap };
}

function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const n = Number.parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unsupported colour ${value}`);
}

/** Source-over compositing of a (possibly translucent) colour onto an opaque one. */
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => (top[i] as number) * top[3] + (under[i] as number) * (1 - top[3])).concat(1) as unknown as Rgba;

/** color-mix(in srgb, a p%, b) for two opaque colours: a straight per-channel mix. */
const mix = (a: Rgba, p: number, b: Rgba): Rgba => [0, 1, 2].map((i) => (a[i] as number) * p + (b[i] as number) * (1 - p)).concat(1) as unknown as Rgba;

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;

/**
 * A pairing to check. `bg` may be translucent (a status tint): it is then
 * composited over `on`, the opaque surface it sits on in the layout.
 */
interface Pair {
  fg: string;
  bg: string;
  on?: string;
  min: number;
  why: string;
}

const STATUSES = ["working", "approval", "waiting", "failed", "done", "offline", "neutral"] as const;
const SURFACES = ["bg", "surface", "surface-2"] as const;

const PAIRS: readonly Pair[] = [
  // Body copy. bg = page, surface = cards, surface-2 = notices, inputs, hovered cards, expanded alert groups.
  ...["text", "text-2", "muted", "faint"].flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: TEXT, why: "body, secondary, muted and faint text (meta, times, placeholders)" }))),
  { fg: "text", bg: "surface-3", min: TEXT, why: "hovered .btn and the active .topnav link" },
  // Links are --accent everywhere, --accent-hover on hover; also .msg-assistant head, .unread-tag.
  ...["accent", "accent-hover"].flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: TEXT, why: "links and accent text" }))),
  { fg: "accent-ink", bg: "accent", min: TEXT, why: ".btn.primary, .badge-count, .skip-link" },
  { fg: "accent-ink", bg: "accent-hover", min: TEXT, why: ".btn.primary:hover" },
  // Status colour as text: plain StatusBadge on cards (surface, surface-2 on hover), .alert-kind
  // (surface, surface-2 inside an expanded group), .conn on host cards and the host header (bg),
  // .field-error, .host-warning, .stale-tag, .btn.danger.
  ...STATUSES.flatMap((s) => SURFACES.map((bg) => ({ fg: `st-${s}`, bg, min: TEXT, why: "status colour as text" }))),
  // Status on its own tint: the .status.pill badge (SessionPage header, on the page bg), and
  // .btn.danger:hover on a card.
  ...STATUSES.map((s) => ({ fg: `st-${s}`, bg: `st-${s}-bg`, on: "bg", min: TEXT, why: ".status.pill badge on its tint" })),
  { fg: "st-failed", bg: "st-failed-bg", on: "surface", min: TEXT, why: ".btn.danger:hover inside a card" },
  // Body text on tinted panels: pressed .state-chip (text on its status tint, page bg),
  // .notice.warn/.success (text-2), .notice.error and .settings-confirm (text, in a card).
  ...STATUSES.map((s) => ({ fg: "text", bg: `st-${s}-bg`, on: "bg", min: TEXT, why: "pressed .state-chip label on its tint" })),
  ...(["approval", "working"] as const).flatMap((s) => (["bg", "surface"] as const).map((on) => ({ fg: "text-2", bg: `st-${s}-bg`, on, min: TEXT, why: `.notice.${s === "approval" ? "warn" : "success"} copy` }))),
  ...(["bg", "surface"] as const).map((on) => ({ fg: "text", bg: "st-failed-bg", on, min: TEXT, why: ".notice.error and .settings-confirm copy" })),
  // Environment pill tones (App.tsx, mobile.css): demo, live, live.warn, live.down, default muted.
  // In the top bar (≈ bg, see color-mix note), as a static pill in Settings (surface), and hovered (surface-2).
  ...["muted", "demo", "st-working", "st-approval", "st-failed"].flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: TEXT, why: ".env-pill tone" }))),
  { fg: "demo", bg: "surface-2", min: TEXT, why: ".tag.demo inside an expanded alert group" },
  // Setup checklist (setup.css): --c is the mark's ring and glyph. neutral = upcoming/blocked, working = done,
  // approval = unknown, accent = current on its tint (accent-soft over the card surface).
  ...["neutral", "working", "approval"].map((s) => ({ fg: `st-${s}`, bg: "surface", min: NON_TEXT, why: ".setup-mark ring and glyph" })),
  { fg: "accent", bg: "accent-soft", on: "surface", min: NON_TEXT, why: ".setup-step.ss-current mark" },
  { fg: "accent", bg: "accent-soft", on: "surface", min: TEXT, why: "accent text on the current setup step" },
  { fg: "text", bg: "accent-soft", on: "surface", min: TEXT, why: ".setup-state, title on the current step" },
  { fg: "text-2", bg: "accent-soft", on: "surface", min: TEXT, why: ".setup-detail on the current step" },
  { fg: "muted", bg: "surface", min: TEXT, why: ".setup-state (upcoming steps)" },

  // Non-text (1.4.11). The focus ring is 2px of --bg then 2px of --accent; its outer edge
  // meets whatever surface the control sits on, so --accent must stand out from each.
  ...SURFACES.map((bg) => ({ fg: "accent", bg, min: NON_TEXT, why: "focus ring (--focus) against its surroundings" })),
  { fg: "accent", bg: "surface-2", min: NON_TEXT, why: "focused .input/.select border" },
  { fg: "accent", bg: "surface", min: NON_TEXT, why: "checked .switch track in a card" },
  { fg: "muted", bg: "surface-3", min: NON_TEXT, why: "unchecked .switch knob on its track" },
  { fg: "accent-ink", bg: "accent", min: NON_TEXT, why: "checked .switch knob on its track" },
  // Status dots and hollow rings are always paired with a text label, but they are the fastest
  // read on a phone; hold them to 3:1 on the page and on cards.
  ...STATUSES.flatMap((s) => (["bg", "surface"] as const).map((bg) => ({ fg: `st-${s}`, bg, min: NON_TEXT, why: "status dot / hollow ring" }))),
  // Control boundaries (G33): .input, .select, .btn, the unchecked .switch track and .state-chip
  // draw their edge with --control-line. It meets the page, cards, notices and inputs' own fill
  // (surface-2), and the warn/error notice tints that hold Retry buttons. --line-strong stays a
  // lighter decorative rule (dividers, the timeline rail) and is not held to 3:1.
  ...[...SURFACES, "surface-3"].map((bg) => ({ fg: "control-line", bg, min: NON_TEXT, why: "control boundary" })),
  ...(["approval", "failed"] as const).flatMap((s) =>
    (["bg", "surface"] as const).map((on) => ({ fg: "control-line", bg: `st-${s}-bg`, on, min: NON_TEXT, why: `control boundary inside .notice.${s === "approval" ? "warn" : "error"}` })),
  ),
];

/**
 * color-mix() backgrounds between two opaque tokens resolve to a straight sRGB
 * mix, so they are checked too. Translucent mixes are not: see UNVERIFIED.
 */
interface MixPair {
  fg: string;
  mix: readonly [string, number, string];
  min: number;
  why: string;
}
const MIX_PAIRS: readonly MixPair[] = [
  // .offline-banner: color-mix(--c 12%, --surface), --c offline / approval / failed.
  ...(["offline", "approval", "failed"] as const).flatMap((s) => [
    { fg: "text-2", mix: [`st-${s}`, 0.12, "surface"] as const, min: TEXT, why: ".offline-banner copy" },
    { fg: "text", mix: [`st-${s}`, 0.12, "surface"] as const, min: TEXT, why: ".offline-banner strong" },
    { fg: `st-${s}`, mix: [`st-${s}`, 0.12, "surface"] as const, min: NON_TEXT, why: ".offline-banner icon" },
  ]),
  // .session-card.attention: color-mix(--c 5%, --surface), hover color-mix(--c 8%, --surface-2).
  ...STATUSES.flatMap((s) =>
    ([
      [0.05, "surface"],
      [0.08, "surface-2"],
    ] as const).flatMap(([p, base]) =>
      ["text", "text-2", "muted", "faint", `st-${s}`, "accent"].map((fg) => ({ fg, mix: [`st-${s}`, p, base] as const, min: TEXT, why: ".session-card.attention text (title, summary, meta, time, badge, unread tag)" })),
    ),
  ),
];

/*
 * Not computable from tokens alone, so not checked here; a real browser must
 * judge them. Listed so the gap is explicit, not silent:
 * - .topbar: color-mix(--bg 86%, transparent) under a backdrop blur. Text over it
 *   depends on what has scrolled beneath; checked above as if on --bg.
 * - .tabbar: color-mix(--surface 92%, transparent), same caveat; checked as if on --surface.
 * - Borders mixed with color-mix (.btn.danger, .tag.demo, .env-pill.demo, .unread-tag,
 *   .stale-tag, .notice.*, .alert-item.unread): decorative; the text inside carries the meaning.
 * - .btn:disabled at opacity 0.5: inactive controls are exempt from 1.4.3.
 * - The .select chevron (a linear-gradient of --muted) and the .st-running pulse.
 */

/**
 * The rules whose border is a control's boundary, and the token it must use.
 * Guards against a control going back to a decorative line (G33). .tag is not
 * listed: it is a non-interactive label, and its text carries the meaning.
 */
const CONTROL_BORDER_RULES: readonly RegExp[] = [/\.btn/, /\.input, \.select/, /\.switch input/, /\.state-chip/, /\.env-pill/];

/** .btn.danger mixes its border: color-mix(--st-failed 45%, --control-line). */
const DANGER_BORDER_MIX = ["st-failed", 0.45, "control-line"] as const;

const { dark, light, lightMap, systemMap } = themes(css);
const THEMES = { dark, light } as const;

function colour(theme: Theme, name: string): Rgba {
  const value = theme[name];
  if (value === undefined) throw new Error(`--${name} is not defined`);
  return parseColour(value);
}

function ratioOf(theme: Theme, p: Pair): number {
  const fg = colour(theme, p.fg);
  const bg = p.on ? over(colour(theme, p.bg), colour(theme, p.on)) : colour(theme, p.bg);
  if (fg[3] !== 1) throw new Error(`--${p.fg} is translucent; composite it explicitly`);
  if (bg[3] !== 1) throw new Error(`--${p.bg} is translucent; give the surface it sits on`);
  return contrast(fg, bg);
}

const label = (p: Pair) => `${p.fg} on ${p.bg}${p.on ? ` over ${p.on}` : ""}`;

describe("contrast maths", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrast([255, 255, 255, 1], [255, 255, 255, 1])).toBe(1);
    // #777 on white is the textbook 4.48:1, just under AA.
    expect(contrast(parseColour("#777777"), parseColour("#ffffff"))).toBeCloseTo(4.48, 2);
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([127.5, 127.5, 127.5, 1]);
  });
});

describe("theme parsing", () => {
  it("reads every live colour token in both themes", () => {
    for (const name of ["bg", "surface", "surface-2", "surface-3", "text", "text-2", "muted", "faint", "accent", "accent-ink", "demo", "control-line", ...STATUSES.flatMap((s) => [`st-${s}`, `st-${s}-bg`])]) {
      expect(() => colour(dark, name)).not.toThrow();
      expect(() => colour(light, name)).not.toThrow();
    }
    expect(light.bg).not.toBe(dark.bg);
  });

  it("maps the light palette identically for System and explicit Light", () => {
    // Otherwise "System" on a light OS could differ from choosing Light, and this test would check only one.
    expect(systemMap).toEqual(lightMap);
  });
});

describe.each(Object.keys(THEMES) as (keyof typeof THEMES)[])("%s theme", (name) => {
  const theme = THEMES[name];

  it("meets AA for every token pairing in use", () => {
    const failures = PAIRS.map((p) => ({ pair: label(p), raw: ratioOf(theme, p), min: p.min, why: p.why })).filter((r) => r.raw < r.min)
      .map(({ raw, ...r }) => ({ ...r, ratio: Number(raw.toFixed(3)) }));
    expect(failures).toEqual([]);
  });

  it("meets AA on the opaque color-mix backgrounds", () => {
    const failures = MIX_PAIRS.map((p) => {
      const [a, pct, b] = p.mix;
      const ratio = contrast(colour(theme, p.fg), mix(colour(theme, a), pct, colour(theme, b)));
      return { pair: `${p.fg} on color-mix(${a} ${pct * 100}%, ${b})`, ratio, min: p.min, why: p.why };
    })
      // WCAG thresholds are not rounded: 4.499:1 fails.
      .filter((r) => r.ratio < r.min)
      .map((r) => ({ ...r, ratio: Number(r.ratio.toFixed(3)) }));
    expect(failures).toEqual([]);
  });

  it("gives the .btn.danger mixed border 3:1 on the page, cards and notices", () => {
    const [a, pct, b] = DANGER_BORDER_MIX;
    const border = mix(colour(theme, a), pct, colour(theme, b));
    const failures = SURFACES.map((bg) => ({ bg, ratio: Number(contrast(border, colour(theme, bg)).toFixed(3)) })).filter((r) => r.ratio < NON_TEXT);
    expect(failures).toEqual([]);
  });
});

describe("control boundaries (G33)", () => {
  it("draw every control border with --control-line, not a decorative line", () => {
    for (const selector of CONTROL_BORDER_RULES) {
      const body = ruleBody(css, selector);
      expect(body, selector.source).toMatch(/border:\s*1px solid var\(--control-line\)/);
    }
    expect(ruleBody(css, /\.btn\.danger/)).toContain(`color-mix(in srgb, var(--${DANGER_BORDER_MIX[0]}) ${DANGER_BORDER_MIX[1] * 100}%, var(--${DANGER_BORDER_MIX[2]}))`);
  });
});
