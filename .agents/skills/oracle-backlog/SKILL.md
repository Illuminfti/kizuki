---
name: oracle-backlog
description: >-
  Use when the Kizuki ship backlog cron (Hermes grok-4.6) is draining
  issues on https://github.com/Illuminfti/kizuki . Read the board, rank
  with grok-4.6, implement a bounded slice, test, merge this lane's PR,
  write the next pickup. Work Pro OFF. No GPT-6 / Personal Pro / oracle browser.
---

# Kizuki ship backlog (oracle-backlog skill)

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else in this playbook. They
are binding and override every other document in the tree, including this
one. Then load `orient-repository`, `implement-change`,
`issue-pickup-execution`, and `handoff-work`. Do not load elegance-review
as a substitute for shipping code.

## Seat lock (Albedo / Neuronist 2026-09-15)

- Agent seat: **grok-4.6 / xai-oauth** only.
- **Work Pro OFF.** Do not run the oracle CLI browser engine, do not use GPT-6 Astra,
  do not use `--browser-thinking-time`, do not attach Chrome CDP for model work.
- Rank and implement with grok-4.6. Ship-or-stop: non-SILENT tick must open
  or squash-merge at least one code PR.

## Message board

The durable pickup pointer is GitHub issue **#597**
(`https://github.com/Illuminfti/kizuki/issues/597`). It is not a product
ticket. Never implement it. Never close it.

Every tick, before editing code:

```bash
gh issue view https://github.com/Illuminfti/kizuki/issues/597
```

Treat the issue **body** as current. Comments are history. If the body and
an open PR disagree, the live `gh pr list` and `git fetch` win.

## 1.0 distance knobs

Land code. Prefer bounded implementable slices (including #544-549 / #473 / #103
when unclaimed and code-shaped). Skip repository settings, Launch-only /
unfamiliar-user gates, macOS allowance-gate-only, Astra-owned UI, and
live-provider-only quals with no code slice. Live-account connector quals:
mark BLOCKED, do not farm another synthetic fixture unless #597 Next asks.
Soft-halt Cap does not pause this lane. Tip VERIFY stamp under
`/data/kizuki-oracle-backlog/` only when time remains and Cap policy allows.

## Loop

1. Read #597. Skip any issue the board marks in-flight or already shipped
   this lane unless you are continuing that exact branch.
2. `git fetch origin` in the dedicated worktree. No Chrome / Oracle setup.
3. Merge drain only as specified by the Hermes cron job prompt.
4. Rank remaining issues easiest-first with grok-4.6 (files, failing test,
   one-line acceptance). No separate Pro consult.
5. Work only in the dedicated worktree. One issue per branch
   `agent/oracle-backlog-<n>`. Smallest failing test plus smallest
   implementation. One slice, not the epic.
6. `bun run typecheck` and focused tests on the exact head. Push. Open a PR
   to `main` titled `oracle-backlog: #<n> <short title>` with `Closes #<n>`
   only when the slice finishes the issue. Squash-merge **this lane's** PR
   only after that SHA is green (single CI wait ≤10m).
7. Update #597 **body** to the next pickup (overwrite Now / Shipped /
   Blocked). Add one comment with SHA, PR URL, tests. Then follow
   `handoff-work`.

## Stop

Do not force-push. Do not commit `.maestro/`.
Do not close an issue as "already on main" unless the comment names the
proving files and the exact main SHA. Do not restart the local agent gateway.
Do not paste credentials or captured personal text onto the board.
Do not run Oracle browser, GPT-6 Astra, or Personal Pro.
