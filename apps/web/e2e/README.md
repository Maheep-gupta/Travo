# Browser checks

```bash
npm run test:e2e                # from the repo root: build, then run the checks
# or, if dist/ is already built:
npm run e2e -w @mc/web
```

## What it does

`run.mjs` serves `apps/web/dist` and `harness/` from an in-process HTTP server on `127.0.0.1` (random port). It then runs the installed Chrome in headless `--dump-dom` mode against `harness/checks.html` and prints PASS/FAIL lines. It exits non-zero on any failure.

- **No browser automation protocol, no downloads.** On the managed development laptop, Playwright and CDP-driven browsers are terminated, and extra Chrome switches such as `--disable-extensions` get Chrome blocked by group policy (exit code 1260). The runner deliberately uses a minimal flag set. Don't add flags to get around the policy.
- **Offline and deterministic.** It uses demo mode only, which is a seeded simulator. It never contacts the public internet or a Supabase project. A temporary Chrome profile is created and deleted on every run, and the server is closed in a `finally` block.
- **Fault injection.** The harness calls `/__e2e/fail?pattern=<regex>`, after which the server answers matching `/assets/*` requests with HTTP 503. This is a genuine failed chunk download from the app's point of view, and it needs no test hooks in the app.

## What it covers (65 checks)

- **Dashboard:** filtering by overview card, search and integration, separately and combined, plus the empty states.
- **Navigation:** opening details, Back and Forward, deep links, and unknown routes.
- **Hosts and Settings:** host revocation with confirmation, and the Save/Discard logic in Settings.
- **Page failure (regression):** a lazily loaded page whose chunk fails shows "Couldn't load this page" inside the app shell. Retry keeps showing the error while the download still fails. Navigating away clears it, and after the network recovers, Retry loads the page without a full reload.
- **Startup failure:** if the Supabase backend chunk fails after Connect, the app shows its own "Couldn't start" screen.
- **Layout and accessibility:**
  - no horizontal overflow at 360px and 390px
  - accessible names on every control
  - visible focus indicators
  - text labels on every status

## What it does NOT cover

- **Real input.** Interactions are **synthetic DOM events** (`element.click()`, programmatic input and change events, `history.back()`). They run the app's real handlers, but they aren't physical keyboard, mouse or touch input, and they aren't screen-reader testing.
- **The browser's own offline page.** If the HTML document or the main JS bundle itself fails to load, the browser shows its native error page. The app's error screens can't appear in that case, and these checks don't claim they do.

## Manual checks still needed

1. Keyboard only: Tab through every page and check the order and focus rings. Press Space on a Settings switch and Enter on Retry.
2. Run a screen reader (NVDA or VoiceOver) over the dashboard, a session page and the error screen.
3. On a real phone, check the tab bar and that targets are comfortable to tap.

## Debugging

- `node e2e/run.mjs --serve` only serves the harness. Open the printed URL in your own Chrome to watch the checks run.
- `E2E_DEBUG=1` logs every `/assets/` request together with the current fault pattern.
- `E2E_CHROME=<path>` overrides the browser. `E2E_VIRTUAL_BUDGET_MS` sets the headless dump deadline.
