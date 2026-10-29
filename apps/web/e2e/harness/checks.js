// Browser checks for the built web app, run by e2e/run.mjs in headless Chrome.
//
// IMPORTANT: interactions here are *synthetic DOM events* (element.click(),
// programmatic input/change events, history.back()). They exercise the app's
// real event handlers and routing, but they are NOT physical keyboard, mouse,
// touch or screen-reader testing. See e2e/README.md for the manual checklist.
//
// Data: demo mode only (deterministic seeded simulator). No network access
// beyond the local test server; no Supabase project is contacted.
"use strict";

const results = [];
// Results are written progressively so a stalled run still shows how far it got.
const render = () => (document.getElementById("out").textContent = results.join("\n"));
const log = (ok, msg) => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  render();
};
const step = (name) => {
  results.push(`--- ${name}`);
  render();
};
const frame = document.getElementById("app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = () => frame.contentWindow;
const D = () => frame.contentDocument;
const $ = (s) => D().querySelector(s);
const $$ = (s) => [...D().querySelectorAll(s)];

async function until(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const v = fn();
      if (v) return v;
    } catch {
      /* element not there yet */
    }
    await sleep(50);
  }
  return null;
}
async function load(path, width = 390) {
  frame.width = String(width);
  await new Promise((res) => {
    frame.onload = res;
    frame.src = path;
  });
  await sleep(800);
}
function type(input, value) {
  Object.getOwnPropertyDescriptor(W().HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new (W().Event)("input", { bubbles: true }));
}
function choose(select, value) {
  Object.getOwnPropertyDescriptor(W().HTMLSelectElement.prototype, "value").set.call(select, value);
  select.dispatchEvent(new (W().Event)("change", { bubbles: true }));
}
const cards = () => $$(".session-card");
const statuses = () => $$(".session-card .status").map((e) => e.textContent.trim());
const path = () => W().location.pathname + W().location.search;
const button = (text) => $$("button").find((b) => b.textContent.trim() === text);
const accName = (el) =>
  (
    el.getAttribute("aria-label") ||
    (el.getAttribute("aria-labelledby") || "")
      .split(" ")
      .map((id) => D().getElementById(id)?.textContent || "")
      .join(" ") ||
    el.textContent ||
    el.getAttribute("title") ||
    ""
  ).trim();

// ---- Fault injection: tell the local test server to fail matching chunks ----
async function failChunks(pattern) {
  await fetch(`/__e2e/fail${pattern ? `?pattern=${encodeURIComponent(pattern)}` : ""}`, { cache: "no-store" });
}

async function dashboardChecks() {
  await load("/?demo=1");
  await until(() => cards().length);
  const total = cards().length;
  log(total >= 6, `dashboard renders ${total} demo sessions`);
  log(cards().every((c) => c.querySelector(".tag.demo")), "every session card carries a DEMO tag");
  log($(".section-head h2")?.textContent === "Needs you", "the 'Needs you' section comes first");
  log(statuses().includes("Disconnected"), "a session on an offline host is shown as Disconnected");

  $(".stat.g-working").click();
  await until(() => $(".stat.g-working")?.getAttribute("aria-pressed") === "true" && statuses().every((s) => s === "Working"));
  let st = statuses();
  log(st.length > 0 && st.every((s) => s === "Working"), `'Working' card shows only Working sessions (${st.join(",")})`);
  log(Number($(".stat.g-working strong").textContent) === st.length, "'Working' count equals the cards shown");

  $(".stat.g-attention").click();
  await until(() => $(".stat.g-attention")?.getAttribute("aria-pressed") === "true" && !statuses().includes("Working"));
  st = statuses();
  log(st.length > 0 && st.every((s) => ["Needs approval", "Waiting for you", "Failed"].includes(s)), `'Need you' card filters correctly (${st.join(",")})`);
  $(".stat.g-attention").click();
  await until(() => cards().length === total);
  log(cards().length === total, "clicking the active overview card again clears the filter");

  $(".stat.g-offline").click();
  await until(() => $(".stat.g-offline")?.getAttribute("aria-pressed") === "true");
  type($(".search input"), "nightly");
  await until(() => $$(".sc-title").length === 1);
  log($$(".sc-title").map((e) => e.textContent).join("|") === "Nightly data import", "overview filter + search combine");
  choose($(".toolbar select"), "mock");
  await until(() => /Showing 1 of/.test($(".active-filter")?.textContent || "") && path().includes("provider=mock"));
  log($$(".sc-title").length === 1, "overview filter + search + integration filter combine");
  type($(".search input"), "zzzz-no-match");
  await until(() => $(".state h2"));
  log($(".state h2")?.textContent === "Nothing matches", "no-match empty state is shown");
  button("Clear filters").click();
  await until(() => cards().length === total && $(".search input").value === "");
  log(cards().length === total && !path().includes("q="), "'Clear filters' resets search, overview and integration filters");
  return total;
}

async function navigationChecks(total) {
  type($(".search input"), "auth");
  await until(() => cards().length > 0 && cards().length < total);
  const card = cards()[0];
  const title = card.querySelector(".sc-title").textContent;
  card.click();
  await until(() => $("h1")?.textContent === title);
  log($("h1")?.textContent === title, `a session card opens its detail page ("${title}")`);
  log($$(".tabbar a").find((a) => a.textContent.includes("Sessions"))?.getAttribute("aria-current") === "page", "Sessions tab stays current on a detail page");
  log(D().activeElement?.id === "main", "focus moves to the page content after navigation");
  const detail = W().location.pathname;
  W().history.back();
  await until(() => W().location.pathname === "/" && cards().length);
  log($(".search input")?.value === "auth", "Back returns to the dashboard with the search preserved");
  W().history.forward();
  await until(() => W().location.pathname === detail && $("h1")?.textContent === title);
  log($("h1")?.textContent === title, "Forward returns to the same detail page");
  log(/Replies are off/.test($(".locked")?.textContent || ""), "detail page explains that replies are off");
  log($$("textarea, .locked input, .locked button").length === 0, "no reply or approval controls are rendered");
  log($$(".caps .off").length === 3, "three capabilities are listed as not available");
  return detail;
}

async function deepLinkChecks(detail) {
  await load(`${detail}?demo=1`);
  await until(() => $(".timeline"));
  log(!!$(".timeline"), "deep link to a session renders after a full page load");
  await load("/sessions/00000000-0000-4000-8000-00000000ffff?demo=1");
  await until(() => $(".state h2"));
  log($(".state h2")?.textContent === "Session not found", "unknown session id shows 'Session not found'");
  await load("/does-not-exist?demo=1");
  await until(() => W().location.pathname === "/" && cards().length);
  log(W().location.pathname === "/", "unknown route redirects to the dashboard");
}

async function hostsChecks() {
  await load("/hosts?demo=1");
  await until(() => $$(".host-card").length === 2);
  log($$(".host-card").length === 2, "deep link to /hosts renders both demo hosts");
  let asked = 0;
  W().confirm = () => (asked++, false);
  $(".host-card .btn.danger").click();
  await sleep(300);
  log(asked === 1 && $$(".host-card.revoked").length === 0, "Revoke asks for confirmation; cancelling changes nothing");
  W().confirm = () => (asked++, true);
  const btn = $(".host-card .btn.danger");
  log(/^Revoke access for /.test(btn.getAttribute("aria-label") || ""), "the revoke button names its host");
  btn.click();
  await until(() => $$(".host-card.revoked").length === 1);
  log(/Revoked/.test($(".host-card.revoked")?.textContent || ""), "confirming revokes the host and shows the Revoked state");
  log($$(".host-card.revoked .btn.danger").length === 0, "a revoked host no longer offers Revoke");
  log(/Pairing needs your own Supabase project/.test(D().body.textContent), "pairing explains it is unavailable in demo mode");
}

async function settingsChecks() {
  await load("/settings?demo=1");
  const save = () => $$("button").find((b) => /Save preferences/.test(b.textContent));
  await until(() => save() && $$(".switch input").length === 6);
  log(save()?.disabled === true, "Save is disabled before any change");
  const sw = () => $$(".switch input");
  log(sw().every((i) => i.getAttribute("role") === "switch" && accName(i).length > 2), "all six switches have role=switch and a name");
  const before = sw()[3].checked;
  sw()[3].click();
  await until(() => !save().disabled);
  log(!save().disabled && /Unsaved changes/.test(D().body.textContent), "toggling enables Save and shows 'Unsaved changes'");
  sw()[3].click();
  await until(() => save().disabled);
  log(save().disabled && sw()[3].checked === before, "toggling back to the saved value disables Save again");
  sw()[3].click();
  await until(() => !save().disabled);
  button("Discard changes").click();
  await until(() => save().disabled);
  log(sw()[3].checked === before, "Discard restores the saved values");
  sw()[3].click();
  await until(() => !save().disabled);
  save().click();
  await until(() => /Saved/.test($(".inline-ok")?.textContent || ""));
  log(save().disabled && sw()[3].checked === !before, "Save keeps the new value, shows 'Saved' and disables Save");
}

async function pageLoadFailureChecks() {
  // Regression: a lazy page whose chunk fails to download must show a
  // recoverable error inside the app shell, and Retry must recover it.
  await load("/?demo=1");
  await until(() => cards().length);
  await failChunks("/assets/HostsPage-");
  $$(".tabbar a").find((a) => a.textContent.includes("Hosts")).click();
  const alert = await until(() => $(".page-error[role=alert]"));
  log(!!alert && /Couldn't load this page/.test(alert.textContent), "failed Hosts chunk shows 'Couldn't load this page' (role=alert)");
  log(!!$(".topbar .brand") && $$(".tabbar a").length === 3, "header and navigation stay visible during the page error");
  const retry = button("Retry");
  log(!!retry && retry.tagName === "BUTTON" && retry.type === "button", "Retry is a real, keyboard-focusable button");

  // Retry while still failing: error stays, no crash.
  retry.click();
  await sleep(600);
  log(!!$(".page-error"), "Retry while the download still fails keeps showing the error");

  // Navigating elsewhere clears the error.
  $$(".tabbar a").find((a) => a.textContent.includes("Sessions")).click();
  await until(() => cards().length && !$(".page-error"));
  log(!$(".page-error") && cards().length > 0, "navigating to another page clears the error");

  // Back to Hosts (still failing), then restore the network and Retry.
  $$(".tabbar a").find((a) => a.textContent.includes("Hosts")).click();
  await until(() => $(".page-error"));
  await failChunks(null);
  const marker = (W().__noReload = Symbol("same document"));
  button("Retry").click();
  await until(() => $$(".host-card").length === 2);
  log($$(".host-card").length === 2 && !$(".page-error"), "after the network recovers, Retry loads the Hosts page");
  log(W().__noReload === marker, "recovery happened without a full page reload");

  // Startup failure is a different path: the Supabase backend chunk fails
  // after Connect. The app's own "Couldn't start" screen must appear.
  W().localStorage.clear();
  await load("/");
  await until(() => $("#h-connect"));
  await failChunks("/assets/supabase-entry-");
  type($$("form input")[1], "sb_publishable_e2e_dummy_key_not_real_0000");
  $$("form button[type=submit]").find((b) => b.textContent.trim() === "Connect").click();
  await until(() => /Couldn't start/.test($("h1")?.textContent || ""));
  log(/Couldn't start/.test($("h1")?.textContent || "") && !!button("Retry"), "a failed backend download shows the app's 'Couldn't start' screen");
  button("Change backend").click();
  await until(() => $("#h-demo"));
  log(!!$("#h-demo"), "'Change backend' returns to setup after a startup failure");
  await failChunks(null);
  W().localStorage.clear();
}

async function accessibilityAndLayoutChecks(detail) {
  for (const p of ["/?demo=1", `${detail}?demo=1`, "/hosts?demo=1", "/settings?demo=1"]) {
    for (const width of [360, 390]) {
      await load(p, width);
      await sleep(400);
      const overflow = D().documentElement.scrollWidth - W().innerWidth;
      log(overflow <= 0, `${p} @${width}px: no horizontal overflow (${overflow}px)`);
    }
    const focusable = $$("a[href], button, input, select, [tabindex]:not([tabindex='-1'])").filter(
      (e) => (e.offsetParent !== null || e.classList.contains("skip-link")) && !e.disabled,
    );
    const unnamed = focusable.filter((e) => !accName(e) && e.type !== "search" && e.tagName !== "SELECT");
    log(unnamed.length === 0, `${p}: every control has an accessible name`);
    const noRing = focusable
      .filter((e) => !e.classList.contains("skip-link"))
      .filter((e) => {
        e.focus();
        const cs = W().getComputedStyle(e);
        return !((cs.boxShadow && cs.boxShadow !== "none") || (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0));
      })
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
    log(noRing.length === 0, `${p}: visible focus indicator on ${focusable.length} focusable elements${noRing.length ? ` (missing: ${noRing.join(", ")})` : ""}`);
    log($$(".status").every((e) => e.textContent.trim()), `${p}: every status indicator has a text label`);
  }
  const skip = $(".skip-link");
  log(!!skip && !!D().getElementById(skip.getAttribute("href").slice(1)), "skip link targets #main");
}

(async () => {
  try {
    await failChunks(null);
    step("dashboard");
    const total = await dashboardChecks();
    step("navigation");
    const detail = await navigationChecks(total);
    step("deep links");
    await deepLinkChecks(detail);
    step("hosts");
    await hostsChecks();
    step("settings");
    await settingsChecks();
    step("page load failure + retry");
    await pageLoadFailureChecks();
    step("accessibility + layout");
    await accessibilityAndLayoutChecks(detail);
  } catch (e) {
    log(false, `harness error: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" ") : e}`);
  }
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  const total = results.filter((r) => /^(PASS|FAIL)/.test(r)).length;
  results.push(`DONE ${failed} failed of ${total}`);
  render();
})();
