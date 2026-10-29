---
name: tavro-ship
description: Tavro's ship loop for one unit of work — pick the next roadmap task, define acceptance criteria, implement, verify, review, commit locally and update the roadmap. Use for every Tavro feature, fix or polish task.
---

# Ship one unit of Tavro work

1. **Orient.** Read `docs/ROADMAP.md` (Next task, Blocked), `git status` and `git log --oneline -5`. Don't touch uncommitted changes you didn't make.
2. **Define.** Write the task's acceptance criteria, what must not change, and how you'll verify it, in the roadmap's "Next task" section. If the task crosses the security baseline in `CLAUDE.md`, stop and ask the user.
3. **Implement** a complete slice:
   - pure logic in `packages/domain` with unit tests;
   - UI in `apps/web`, with loading, empty, error and permission states, accessible labels and responsive layout;
   - docs updated where behaviour changes.
4. **Verify.** Run `npm run check`, and also `npm run build -w @mc/web` for web changes. Fix any failures; never weaken a test. Note which checks are unavailable (`test:e2e`, `test:db`).
5. **Review.** For significant changes, spawn the `qa` agent. For anything touching storage, notifications, network, auth, the connector or the service worker, also spawn `security`. For visible UI, spawn `designer`. Fix valid findings and re-run step 4.
6. **Commit** locally with a plain, descriptive message (no AI attribution). Never push.
7. **Update** `docs/ROADMAP.md`: move the task to Done (with its verification), add any new bugs or debt, set the next task. Record durable decisions in `docs/DECISIONS.md` and new limitations in `docs/QUALITY.md`.
8. **Continue** with the next unblocked task. When context runs low, finish the current unit, then write the handoff into the roadmap's "Next task" section.
