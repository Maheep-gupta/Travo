# Decision records

Short ADRs. Architecture-level decisions from before 2026-10-29 are summarised in docs/ARCHITECTURE.md ("Key decisions"); these entries add the product and process decisions. Do not record a proposal here until the user has approved it.

| ID | Date | Decision | Why | Revisit when |
|---|---|---|---|---|
| D-001 | 2026-10-29 | BYOS on the user's own Supabase. There is no custom backend server. | User decision. Authorisation is enforced by RLS, so there is no hosting to run. | A requirement appears that RLS can't express |
| D-002 | 2026-10-29 | Demo data by default. The real Claude Code adapter stays disabled until `npm run test:db` passes. | Isolation is unverified (Docker is blocked) | RLS tests pass |
| D-003 | 2026-10-29 | No replies, resume, remote approvals or command channel. Never build a relay that recreates Remote Control. | Org policy `allow_remote_control: false`, plus the user's decision | Org policy changes and the user approves |
| D-004 | 2026-10-29 | Transcript content goes only to a loopback database, never to notifications, storage, caches or logs | Privacy constraint | A cloud policy is approved |
| D-005 | 2026-10-29 | Work autonomously inside the repository. Git stays local: no push, no remote, no deploy. Ask before external, cloud, paid, global or policy-affecting actions. | User approval of Phases 0–3 | User says otherwise |
| D-006 | 2026-10-29 | Security boundaries stay unchanged during autonomous work | User decision | User approves a change |
| D-007 | 2026-10-29 | Keep the `@mc/*` package scope | Renaming is migration work with no user-visible value | A package is published |
| D-008 | 2026-10-29 | Alerts are computed client-side from the session and host snapshots the app already reads, using pure `detectAlerts` in `@mc/domain`. They are not a new database table. | Works in demo and Supabase modes with no schema change or extra data, and the Expo app can reuse it | Background push (M6) needs server-side detection |
| D-009 | 2026-10-29 | System notifications are foreground-only (Tavro open, tab in the background), opt-in per device, and use generic text with no session titles | Honest capability with no push infrastructure, and lock screens can be seen by others | M6 architecture approved |
