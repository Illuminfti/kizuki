---
name: oracle-backlog
description: >-
  Use when the Kizuki ship backlog cron (grok-4.6 / xai-oauth) is draining
  GitHub issues. Read the board, run exactly one gpt-6-astra planning
  consult with standard thinking time (never pro), implement a bounded
  slice, test, merge this lane's PR, write the next pickup. Work Pro OFF.
  Owner TAP YES 2026-09-15. Neuronist seat lock.
---

# Kizuki ship backlog (oracle-backlog skill)

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else in this playbook. They
are binding and override every other document in the tree, including this
one. Then load `orient-repository`, `implement-change`,
`issue-pickup-execution`, and `handoff-work`. Do not load elegance-review
as a substitute for shipping code.

## Seat lock 2026-09-15 (Neuronist / owner TAP YES)

- Implementer seat: **grok-4.6 / xai-oauth** only.
- **Work Pro OFF.** Never pass `--browser-thinking-time pro`. The one
  planning consult uses `standard` only.
- Cap soft-halt holds: this lane does not pause for Cap.
- Exactly one Oracle planning consult per tick (recipe below), then
  continue on grok-4.6. Never a second Pro consult.
- Dedicated worktree: `/data/kizuki-worktrees/oracle-backlog`.

## Message board

The durable pickup pointer is GitHub issue **#597**. It is not a product
ticket. Never implement it. Never close it. Pickup this board only.

Every tick, before editing code:

```bash
gh issue view 597
```

Treat the issue **body** as current. Comments are history. If the body and
an open PR disagree, the live `gh pr list` and `git fetch` win.

## 1.0 distance knobs

Land code. PRIORITY_FIRST when unclaimed and code-shaped: #539, #543,
#544–549, #473, #103. Skip repository settings, Launch-only /
unfamiliar-user gates, macOS allowance-gate-only, Astra-owned UI, and
live-provider-only quals with no code slice. Live-account connector quals:
mark BLOCKED, do not farm another synthetic fixture unless #597 Next asks.
Tip VERIFY stamp under `/data/kizuki-oracle-backlog/` only when time
remains and Cap policy allows.

## Loop

1. Read #597. Skip any issue the board marks in-flight or already shipped
   this lane unless you are continuing that exact branch.
2. `git fetch origin` in `/data/kizuki-worktrees/oracle-backlog`.
3. Merge drain only as specified by the ship backlog cron prompt.
4. Exactly one Oracle planning consult for the whole tick. Attach ChatGPT
   Chrome; do not launch a second Chrome; do not combine attach with
   `--browser-keep-browser`; do not inject cookie files. Hard-kill the
   consult, then continue on grok-4.6:

```bash
export DISPLAY=:100
bash /home/ubuntu/.oracle/ensure-chrome.sh
timeout 12m oracle --engine browser --model gpt-6-astra --browser-thinking-time standard \
  --browser-attach-running --remote-chrome 127.0.0.1:9333 \
  -p "Kizuki 1.0 PRIORITY_FIRST. ONLY ranked implementable slices: issue, files, failing test, one-line acceptance. Max ~400 words. Prefer #539/#543/#544-549/#473/#103." \
  --file AGENTS.md --file docs/CURRENT.md --file docs/decision-log.md \
  --file /data/kizuki-oracle-backlog/oracle-backlog-SKILL-OVERRIDE.md
```

   On timeout, login, 429, or any other consult failure: record
   `oracle_failed` on #597 and keep shipping. Do not stop the tick. Never
   start a second Pro consult.
5. Work only in the dedicated worktree. One issue per branch
   `agent/oracle-backlog-<n>`. Smallest failing test plus smallest
   implementation. One slice, not the epic. Rank remaining issues
   easiest-first with grok-4.6 when the consult did not return a rank.
6. `bun run typecheck` and focused tests on the exact head. Push. Open a PR
   to `main` titled `oracle-backlog: #<n> <short title>` with `Closes #<n>`
   only when the slice finishes the issue. Squash-merge **this lane's** PR
   only after that SHA is green (single CI wait ≤10m).
7. **Ship-or-stop:** a non-SILENT tick must open or squash-merge at least
   one code PR. Otherwise write `[SILENT]` plus a Blocked reason on #597
   and stop.
8. Update #597 **body** to the next pickup (overwrite Now / Shipped /
   Blocked). Add one comment with SHA, PR URL, tests, and Oracle session
   id (or `oracle_failed`). Then follow `handoff-work`.

## Stop

Do not force-push. Do not commit `.maestro/`.
Do not close an issue as "already on main" unless the comment names the
proving files and the exact main SHA. Do not restart the local agent gateway.
Do not paste credentials or captured personal text onto the board.
Do not run a second Oracle consult. Do not use `--browser-thinking-time pro`.
