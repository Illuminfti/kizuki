---
name: oracle-backlog
description: >-
  Use when the Hermes Oracle GPT-6 Pro cron (or an equivalent session) is
  draining Illuminfti/kizuki GitHub work: merge PRs that can be merged, read
  the board, consult Oracle, implement a bounded slice, test, merge, write
  the next pickup.
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

## Merge drain

Illumi authorized this lane to squash-merge open PRs into `main` when they
can actually be merged, including other agents' PRs.

Do this before picking new issues. Re-read live GitHub state. Merge only
when all of these hold:

- not a draft; title not WIP
- base is `main`
- `mergeable` is `MERGEABLE`
- `mergeStateStatus` is not `BLOCKED`, `DIRTY`, `BEHIND`, `DRAFT`, or `UNKNOWN`
- reviewDecision is not `CHANGES_REQUESTED`
- every check completed; conclusions only `SUCCESS`, `NEUTRAL`, or `SKIPPED`
- changed files do not include `.env`, cookies, keys, vaults, or chrome-profile paths

Then `gh pr merge <n> --repo Illuminfti/kizuki --squash --match-head-commit <headRefOid>`.
Never `--admin`. Verify `mergedAt` before claiming. Cap 10 merges per tick.
Skip and leave the PR if GitHub refuses.

Merging a green PR is not editing someone else's branch. Do not force-push
or rewrite their commits.

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

Do not use `--admin`. Do not merge drafts, blocked, conflicting, behind,
failing, or pending-check PRs. Do not force-push or rewrite someone else's
branch. Do not commit `.maestro/`.
Do not close an issue as "already on main" unless the comment names the
proving files and the exact main SHA. Do not restart Hermes gateways.
Do not paste credentials or captured personal text onto the board.
