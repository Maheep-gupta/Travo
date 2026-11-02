# TAVRO — MASTER PRODUCT REQUIREMENTS SPECIFICATION

Version 1.0, founder-approved product direction. Received 2026-11-02. This file is the permanent product requirements source; the gap analysis and status per requirement live in `docs/GAP_ANALYSIS.md`, execution order in `docs/ROADMAP.md`.

**Product:** Tavro · **Tagline:** Your AI sessions. In sync. · **Category:** AI coding session monitoring and management
**Primary experience:** Mobile-first, with a desktop web dashboard · **Initial platform:** Installable PWA · **Future platform:** Native mobile where justified
**Design direction:** Premium, modern, dark developer-tool experience with an ember accent.

---

## PART 1 — PRODUCT VISION

### 1.1 What is Tavro?
Tavro is a personal command center for developers who use AI coding agents. Developers run multiple AI coding sessions across projects, terminals, machines and tools, and need to know: which agents are working, which have finished, which need attention or approval, which have errors, which machine runs each session, which have stopped reporting, and what needs attention right now. Its primary purpose is to eliminate repeatedly checking terminals to discover whether an agent needs attention. **Tavro should make developers feel informed, in control, and confident that important events will not be missed.**

### 1.2 Product principles
1. Visibility first. 2. Reliability over appearance: never show outdated information as live. 3. Privacy by default. 4. Mobile first. 5. Honest communication: distinguish actual from uncertain states. 6. Minimal friction. 7. Extensibility to additional agents. 8. Local-first development: no unnecessary cloud dependencies. 9. Progressive capability: unsupported functionality clearly identified. 10. Premium quality.

### 1.3 Target users
Primary: Claude Code users; developers running multiple agents; independent developers across projects; long-lived sessions; developers switching between desktop and mobile. Secondary: small teams; developers with multiple workstations; users of future AI coding tools.

### 1.4 Core value proposition
Open Tavro on a phone and quickly understand the status of coding sessions without inspecting every terminal.

---

## PART 2 — PRODUCT STRUCTURE
Areas: 1 Dashboard · 2 Sessions · 3 Session details · 4 Alerts and notifications · 5 Hosts · 6 Integrations · 7 Settings · 8 Authentication and account · 9 Onboarding and setup · 10 Diagnostics and connection health. Inspect the existing implementation before creating or reorganizing these.

### 2.1 Main navigation
Desktop: persistent sidebar or equivalent compact navigation; main content; clear account and connection status; consistent navigation between dashboard, alerts, sessions, hosts, settings. Mobile: compact navigation; no horizontal scrolling; touch-friendly; session and alert info prioritized; no squeezed desktop patterns. The designer selects the pattern based on usability and existing architecture.

---

## PART 3 — DASHBOARD

### 3.1 Overview
Primary landing page with an immediate overview. Required: total sessions; working; waiting for input; needing approval; completed; disconnected; sources unavailable; unread alerts. No misleading aggregates when data is stale or unavailable.

### 3.2 Session cards
Where available: title or safe display name; provider; project display name; host; state; last activity; **last successful source update**; attention indicator; error/availability indicator. Never expose sensitive absolute paths; avoid revealing home-directory names.

### 3.3 Filtering
All; Working; Waiting for you; Needs approval; Completed; Disconnected; Source unavailable. Optional: host, provider, project, recent activity. Filters compose; invalid URL params ignored safely; Back/Forward predictable; filters persist within the browsing experience; helpful empty results.

### 3.4 Sorting
Most recently active; needs attention first; working first; recently completed; host or project. Deterministic.

### 3.5 States
First-time empty; no connected hosts; no sessions; loading; partial data; offline; source unavailable; authentication expired; recoverable error; complete error. Never display fabricated sessions as real; demo data visibly identified.

---

## PART 4 — SESSION MANAGEMENT

### 4.1 Lifecycle
States: Working; Waiting for you; Needs approval; Completed; Disconnected; Source not responding; Unknown or stale. **Distinguish session state from source health.** A session last observed working whose source became unavailable must not silently become completed.

### 4.2 Transitions
Working → Waiting / Needs approval / Completed / Source not responding; Waiting → Working; Needs approval → Working only after a genuine update; Completed → new lifecycle or supported restart; Source not responding → recovered after a successful read. Prevent duplicate transition events; ignore invalid transitions where appropriate; preserve timestamps; distinguish missing data from negative evidence; handle delayed and out-of-order updates; avoid false transitions after sleep or network interruption; recover cleanly after connector restart.

### 4.3 Session details
Identity; provider; host; project display name; state; **source health**; **last successful update**; last activity; lifecycle history; **related alerts**; connection diagnostics where useful. No transcripts or prompt contents unless a future authorized feature supports them.

### 4.4 Session actions
View details; open associated alerts; filter by provider or host; dismiss relevant alerts; navigate to the local development environment where safely supported. No invented remote commands. Remote replies, command execution and approvals stay disabled when prohibited by policy.

---

## PART 5 — ALERTS AND ATTENTION ENGINE

### 5.1 Purpose
Notify users when a session requires attention, derived from genuine state changes or reliable events.

### 5.2 Categories
User input required; approval required; session completed; session disconnected; **source unavailable**; connection recovered; **important connector error**. Avoid noise.

### 5.3 Alert lifecycle
Stable id; user association; session association where applicable; category; creation timestamp; read/unread; dismissed where appropriate; safe content.

### 5.4 Behavior
Only meaningful transitions; dedupe; never duplicate from multiple tabs; no false disconnection alerts during sleep; never lose new alerts at capacity; preserve the correct user's state; clear or isolate on sign-out; handle concurrent tab updates; never expose one user's data to another.

### 5.5 Notification center
See all and unread alerts; unread count; mark read; dismiss; open the related session; navigate back to the dashboard. Meaningful empty, loading and error states.

### 5.6 Browser/system notifications
Disabled by default; explicit consent; explain permissions; handle unsupported and denied; respect preferences; privacy-safe generic content by default; no sensitive content. **Session names remain disabled by default under D-013; do not enable without founder authorization.** Explain that notifications may only work while the app is open unless genuine background infrastructure exists and is verified. Never advertise background push that doesn't exist.

### 5.7 Future
Evaluate background push, native notifications, per-category preferences, quiet hours, grouping, delivery diagnostics; implement only when platform and privacy requirements can be met.

---

## PART 6 — HOSTS

### 6.1 Overview
Display name; provider/connector; connection state; last successful heartbeat; last activity; number of known sessions; connector version where appropriate.

### 6.2 Lifecycle
Connected; connecting; disconnected; unavailable; authentication required; **source not responding**. A host must not appear online merely because its last known state was online.

### 6.3 Host details
Identity; connection diagnostics; associated sessions; last successful communication; connector health; recovery status. No sensitive machine identifiers or full private paths.

### 6.4 Multiple hosts
Multiple machines; multiple sessions per machine; independent host health; correct session ownership; recovery after reconnection.

---

## PART 7 — CLAUDE CODE INTEGRATION

### 7.1 Architecture
Provider-specific logic isolated behind a connector/provider abstraction. UI and domain never depend directly on raw CLI output.

### 7.2 Discovery
Groundwork reads `claude agents --json`. Before activation verify real CLI behavior and schemas, version differences, missing CLI, timeout, malformed JSON, permission errors, unreadable output, partial results, unavailable working directories, interrupted reads. Real CLI data only in an approved, authorized environment.

### 7.3 Privacy
No full working-directory paths; no private home-directory names; no raw command output in user-facing errors; no transcripts; no source code; no unnecessary prompt contents; no credentials or environment secrets.

### 7.4 Connector health
Distinguish CLI unavailable; CLI timed out; output invalid; connector process failed; host unavailable; source not responding; session genuinely ended. Failed reads must not mark sessions completed.

### 7.5 Activation
Disabled until: organization policy permits; security review passes; real CLI compatibility verified; session identity reliable; user-data isolation verified; database security tests pass; failure and recovery tested. Respect `allow_remote_control: false`; never build a relay or workaround.

---

## PART 8 — FUTURE PROVIDERS
Extensible provider architecture (terminal agents, IDE assistants, local agents, other platforms). For each: discovery mechanism, session identity, status mapping, host identity, error handling, health monitoring, privacy characteristics, supported capabilities. Never claim support before implementation and verification.

---

## PART 9 — AUTHENTICATION AND ACCOUNTS

### 9.1 Authentication
Secure sign-in; clear errors; expiration handling; sign-out; account switching; user isolation; safe session restoration; protection against stale cached data.

### 9.2 Isolation
Never reuse a previous user's cached alerts; mix sessions across accounts; reuse another account's notification preferences; show stale private data after sign-out; trust client-side user ids as authorization.

### 9.3 Lifecycle tests
Sign-in; sign-out; sign-in after sign-out; switching accounts; expired auth; network interruption during auth; session restoration; multiple tabs; reauthentication.

---

## PART 10 — DATA AND SYNCHRONIZATION
10.1 Separate domain, connectors, persistence, API clients, UI, auth, notification delivery; preserve the workspace architecture where appropriate. 10.2 Define what is persisted and why (users, hosts, sessions, state history, alerts, notification prefs, connector status, integration config); store nothing unnecessary. 10.3 Sync: simultaneous updates; never overwrite newer with stale; stable ids; defined conflict resolution; reconnect and recovery; account isolation; no duplicate events. 10.4 Before production: review every table and RLS; verify ownership and insert/select/update/delete; test cross-user access, account switching, auth expiration, concurrent updates, migration rollback or recovery. DB security tests must pass before enabling the real integration. Never mark unexecuted tests as passing.

---

## PART 11 — ONBOARDING
11.1 First launch explains: what Tavro does; how sessions are discovered; what is collected; what is stored locally or remotely; available integrations; unavailable features. 11.2 Setup steps: account; connecting an approved host; installing/configuring the connector; verifying the connection; seeing the first session; notification settings. 11.3 States: missing prerequisites; CLI not installed; auth required; connector not responding; invalid configuration; unsupported environment; success. Never pretend setup succeeded if verification failed.

---

## PART 12 — SETTINGS
Account (info, authentication, sign-out) · Notifications (browser notifications, permission state, categories, privacy, quiet hours when supported) · Integrations (providers, state, diagnostics, capabilities) · Appearance (dark, light, system) · Privacy (what's collected, retention, notification privacy, local data) · Application (version, build, installation status, diagnostics). **Every setting must have a real effect; no decorative controls.**

---

## PART 13 — DESIGN AND UX
13.1 Dark-first; restrained ember accent; high-quality typography; clear hierarchy; subtle borders; balanced spacing; consistent icons; clean cards; elegant transitions; minimal clutter. Reference inspiration for quality only, never copied assets or branding. 13.2 Small and large phones, tablets, laptops, desktops; no horizontal scrolling; no clipped controls; readable type; touch targets; responsive cards; usable navigation at every breakpoint. 13.3 WCAG 2.2 AA target: keyboard, visible focus, semantic controls, accessible names, announcements, contrast, reduced motion, accessible errors, meaningful status indicators, touch-friendly. **Tested, not merely described.** 13.4 Feedback for every major action; no dead buttons, unexplained loading, silent failures, misleading success, confusing empty states, excessive dialogs or confirmations.

---

## PART 14 — PWA AND MOBILE
14.1 Valid manifest, name, icons, theme colors, display mode, **installation guidance**, correct launch. 14.2 Define offline behavior: previously loaded UI, cached static assets, local preferences, **clear offline indication**. Never show cached session states as live. A service worker only when caching, update and security behavior are understood and tested. 14.3 Document and, where authorized, test Android browser, installed Android PWA, iOS Home Screen, permission prompts, unsupported browsers, foreground notifications, background only if implemented. 14.4 Evaluate Expo or similar only with genuine native need; don't duplicate prematurely; the web app stays coherent on its own.

---

## PART 15 — SECURITY AND PRIVACY
15.1 Least privilege; explicit authorization; data minimization; user isolation; safe errors; secure defaults; no unnecessary external transfer. 15.2 Never expose transcripts, source code, API keys, environment variables, credentials, full private paths, prompt contents, internal tokens. 15.3 Review auth, authorization, DB access, RLS, cross-account access, local storage, notifications, connector process execution, input validation, error output, dependencies, network, build and deployment config. 15.4 **Absolute constraints:** respect endpoint protection; don't bypass managed browser or Docker restrictions; no unauthorized VPN or networking tools; don't circumvent remote-control settings; don't activate prohibited integrations; don't transmit private information to unauthorized services. If infrastructure is unavailable, continue independent work and document.

---

## PART 16 — RELIABILITY AND RECOVERY
Cover: laptop sleep and restart; network loss; CLI crash; connector crash; database unavailable; auth expired; invalid, delayed or duplicate responses; concurrent tabs; session disappearance; host recovery; app refresh; account switching. For every failure: detect; represent accurately; preserve safe known information; avoid misleading status; recover automatically when appropriate; tell the user when intervention is needed. Sensible timeouts, retry limits and backoff; no endless retries or notification storms.

---

## PART 17 — PERFORMANCE AND MAINTAINABILITY
Fast initial load; efficient rendering; minimal network activity; lazy-loaded heavy features; small bundles; stable memory; efficient polling or events; no needless re-renders. Strong types; explicit domain contracts; reusable components; clear provider interfaces; testable logic; consistent errors; minimal dependencies; maintainable structure. Preserve existing performance improvements.

---

## PART 18 — TESTING
18.1 Unit: transitions, attention classification, alert generation, dedupe, stale-state logic, connector parsing, notification prefs, user isolation, recovery, URL filtering. 18.2 Component: dashboard, session cards, session detail, alerts page, notification settings, hosts page, setup, sign-in, error states, responsive logic where feasible. 18.3 Integration: connector → domain, domain → persistence, auth → user data, alerts → notification center, session updates → dashboard, account switching, multi-tab sync. 18.4 Security: unauthorized access, cross-user exposure, invalid ownership, auth expiration, unsafe notification content, sensitive error output, connector input handling, DB policies. 18.5 Browser and device where approved; if blocked, report honestly. 18.6 Gates per milestone: typecheck, lint, unit, component, relevant integration tests, production build, security checks where available. No suppressed failures.

---

## PART 19 — PRODUCTION READINESS
Product (journeys, onboarding, reliable dashboard, meaningful alerts, accurate states) · Security (isolation, authorization, sensitive data, DB security tests, integration reviews) · Reliability (failure and recovery tested, stale information identified, reconnection, no critical bugs) · UX (responsive, accessible, understandable errors, working controls) · Release (build, documented config, no committed secrets, documented deployment, **licence decision recorded**, privacy reviewed). Status labels per requirement: **Not started · In progress · Implemented · Automated-test verified · Browser/device verified · Security verified · Production ready.** Do not confuse them.

---

## PART 20 — ROADMAP
Phase 1 Core experience (dashboard, cards, details, filtering and sorting, hosts, setup, auth, empty and error states) · Phase 2 Attention and alerts · Phase 3 Reliability (source health, Source Not Responding, stale state, recovery, connector diagnostics, multi-host, sync safety) · Phase 4 Claude Code integration · Phase 5 Data and security · Phase 6 Mobile and PWA · Phase 7 Polish (onboarding, diagnostics, performance, accessibility, docs) · Phase 8 Expansion. Deliver coherent, usable milestones; don't wait for all phases.

---

## PART 21 — ACCEPTANCE CRITERIA (core experience)
1 Purpose understandable. 2 Supported onboarding completable. 3 Hosts and sessions represented correctly. 4 State accurate and **freshness visible**. 5 Attention identifiable. 6 Alerts reliable, no duplicates. 7 Read and dismiss alerts. 8 Notification preferences work. 9 No cross-account leaks. 10 Connector failures communicated honestly. 11 Works on supported mobile and desktop layouts. 12 Errors recoverable where possible. 13 Core accessibility met. 14 Supported functionality tested. 15 Security for enabled integrations verified. 16 Installation and release documented and verified.

---

## PART 22 — AUTONOMOUS OWNERSHIP
This specification is the permanent product target. The product manager continuously compares the product against it; for every requirement: inspect, decide completeness, identify gaps, define work, prioritize, assign, implement, test, review, update status. Make ordinary decisions independently. Escalate only public publishing, paid commitments, licensing, unauthorized external data transfer, or material changes to privacy guarantees. Pending founder decisions must not stop unrelated work. Work in parallel where safe, integrate and review. Keep precise continuation information in the repository. Never claim indefinite background execution.

## PART 23 — IMMEDIATE INSTRUCTIONS (2026-11-02)
Inspect the repository and commits; read roadmap, integration docs, architecture and instructions; produce a detailed gap analysis; establish this spec as the requirements source; update architecture and roadmap; identify dependencies, blockers, risks and workstreams; activate the team; start implementing the highest-priority unfinished requirement immediately. Do not spend the session on documentation.
