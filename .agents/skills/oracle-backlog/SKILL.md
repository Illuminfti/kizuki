---
name: oracle-backlog
description: >-
  Use when the Hermes Oracle GPT-6 Pro cron (or an equivalent session) is
  draining Illuminfti/kizuki GitHub issues: read the board, consult Oracle,
  implement a bounded slice, test, merge this lane's PR, write the next pickup.
---

# Oracle backlog

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else in this playbook. They
are binding and override every other document in the tree, including this
one. Then load `orient-repository`, `implement-change`, `elegance-review`,
`issue-pickup-execution`, and `handoff-work`.

## Message board

The durable pickup pointer is GitHub issue **#597**
(`https://github.com/Illuminfti/kizuki/issues/597`). It is not a product
ticket. Never implement it. Never close it.

Every tick, before editing code:

```bash
gh issue view 597 --repo Illuminfti/kizuki
```

Treat the issue **body** as current. Comments are history. If the body and
an open PR disagree, the live `gh pr list` and `git fetch` win.

## Loop

1. Read #597. Skip any issue the board marks in-flight or already shipped
   this lane unless you are continuing that exact branch.
2. Export `DISPLAY=:100`. ChatGPT Chrome must already be signed in with
   loopback CDP on `127.0.0.1:9333`. If `/json/version` fails, start that
   host's Oracle Chrome keep-alive and wait until CDP answers. The composer
   must be visible, not Log in.
3. One Oracle GPT-6 Astra Pro consult for the whole batch. Attach; do not
   launch a second Chrome; do not combine attach with `--browser-keep-browser`;
   do not inject cookie files.

```bash
oracle --engine browser --model gpt-6-astra --browser-thinking-time pro \
  --browser-attach-running --remote-chrome 127.0.0.1:9333 \
  -p "Kizuki backlog. For each listed issue, name the smallest correct change, exact files, and the test that proves it. Rank easiest-first. Respect AGENTS.md invariants." \
  --file AGENTS.md --file docs/CURRENT.md --file docs/decision-log.md --file package.json
```

If Oracle login/429/timeout fails, record `oracle_failed` on #597 and
continue with this session's model. Do not stop the tick.
4. Work only in the dedicated worktree. One issue per branch
   `agent/oracle-backlog-<n>`. Smallest failing test plus smallest
   implementation. Launch/World-Model tickets: one slice, not the epic.
5. `bun run typecheck` and focused tests on the exact head. Push. Open a PR
   to `main` titled `oracle-backlog: #<n> <short title>` with `Closes #<n>`
   only when the slice finishes the issue. Squash-merge **this lane's** PR
   only after that SHA is green.
6. Update #597 **body** to the next pickup (overwrite Now / Shipped /
   Blocked). Add one comment with SHA, PR URL, tests, Oracle session id.
   Then follow `handoff-work`.

## Stop

Do not merge other agents' PRs. Do not force-push. Do not commit `.maestro/`.
Do not close an issue as "already on main" unless the comment names the
proving files and the exact main SHA. Do not restart Hermes gateways.
Do not paste credentials or captured personal text onto the board.
