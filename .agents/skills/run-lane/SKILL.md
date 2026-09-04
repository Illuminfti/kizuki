---
name: run-lane
description: Execute one lane of a plan to a deterministic finish line — define done before building, prove behavior by running it, build only what the finish line requires, and report honestly when it cannot be reached. Use when handed a numbered milestone, module, or step from a plan document.
---

# Run one lane to its finish line

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else. They are binding and
override every other document in the tree, including this one and including
the plan you were handed. Never restate a superseded policy as current:
owner-invoked promotion or any owner review queue or approval step (D9,
D10), owner labeling of sensitivity (D11), a zero-model floor that writes
canon (D12), a SQLite-only rule for derived retrieval (D13), an owner-started
daemon (D15), or the review gate as the moat (C8).

Then read the root `AGENTS.md`, the nearest scoped `AGENTS.md`, and
`.agents/skills/elegance-review/SKILL.md`, which is the house bar for any
code change.

## What this skill is for

You have been given one lane: a numbered milestone, module, or step from a
plan. Your job is to reach its finish line and stop. Not to improve the
surrounding code, not to add the obvious next feature, not to fix what you
noticed on the way. Those are findings to report, not work to do.

## 1. Define done before you build

Write the finish line first, as something a machine decides.

- A test that fails now and passes when the lane is complete, or
- a script that prints one `PASS <id> <label>` or `FAIL <id> <label> <reason>`
  per assertion and exits non-zero on failure.

Write it before the implementation, run it, and confirm it fails for the
right reason. A finish line you wrote after the code is a description of
what you built, not a specification of what was asked.

**Every check must be able to both pass and fail.** A check that cannot pass
under any circumstance is not a gate, it is a permanent blocker. A check that
cannot fail is decoration. Before accepting a check, state what would make it
go the other way. If you cannot, the check is wrong.

**A check must fail for its own reason.** A refusal test that also passes when
the service is simply unreachable proves nothing. Guard each assertion with
the precondition that makes its result meaningful, and report `BLOCKED` with
the missing precondition rather than passing by accident.

**Check from the right vantage point.** Prove a property from where it
matters: a client-facing property from a client, a containment property from
outside the thing contained. A component asked about itself will tell you
what you wanted to hear.

## 2. Prove behavior, never infer it

If you are about to write "this happens because the code says X", stop and
run it. Reading is how you form a hypothesis. Running is how you learn.

Every claim in your report is one of exactly two kinds, and you must say
which: something you observed, with the command and its output, or something
you reasoned to, marked as unverified. There is no third kind.

When something cannot be run in this environment, say so plainly, name what
is missing, and leave the assertion unproven. `NOT RUN` and `BLOCKED` are
honest results. A fabricated pass is the only unrecoverable failure in this
workflow, because everything downstream then rests on it.

Be careful that your measurement measures what you think. Exit codes lost
across a shell boundary, output swallowed by a pipe, a cached result, a check
that passes because nothing ran — verify the instrument before trusting the
reading.

## 3. Build only what the finish line requires

State, before implementing, the smallest change that makes the finish line
pass. Then make that change.

- Do not add configuration nobody asked for, abstraction with one caller,
  or a capability the lane does not need.
- Do not fix unrelated defects you noticed. Report them.
- Do not refactor code you are merely reading.
- Prefer composing what exists over introducing something new. If the
  codebase already solves this shape of problem, use that solution even if
  yours would be tidier.

**If reaching the finish line seems to require a new surface — a verb, a
port, a table, an endpoint, a flag — stop.** That is a design decision above
your authority, and inventing one produces exactly the fake surface the
repository forbids (invariant 10). Report what is missing and why the lane
cannot proceed without it.

**Never route around an invariant to make a check pass.** If the only way to
green is a second write path, a widened permission, a relaxed boundary, or a
proof that avoids the hard part, then the finish line is wrong or the lane is
blocked. Both are reportable outcomes. Neither is a licence to proceed.

## 4. When the plan is wrong, say so

Plans are written before the code is read. Some of what you were handed will
be wrong about how things actually work.

When an assertion in the plan does not match the code, **do not bend the code
to match the plan.** Establish the real behavior by running it, rewrite that
row of the plan to describe what is true, and record a short finding with the
evidence. A wrong row corrected is worth more than a lane completed against
a fiction.

The same applies to a check whose wording names a command, field or state
that does not exist. Assert the property the row was reaching for, and say in
the plan why the wording changed.

## 5. Isolate the lane

Work in a dedicated branch, and a dedicated worktree when other work exists.
Touch only paths this lane owns. Treat every unfamiliar branch, worktree,
commit and uncommitted change as someone else's.

Never use `git reset --hard`, `git clean`, broad checkout or restore across
the tree, force-push, or history rewriting to tidy up. If you make a mess,
repair it precisely and disclose it.

## 6. Verify on the exact head

Run the lane's own finish line, then the gates the repository requires on
this revision, then anything your change could plausibly have broken —
particularly the finish line of any lane yours builds upon.

Record every command with its exit code. A passing run from an earlier commit
is not evidence for the current one. If the head moved, run it again.

## 7. Report

Return, in this order:

1. **Exact head SHA** and the files changed.
2. **The finish line's full output**, verbatim.
3. **Every verification command with its exit code**, and where it ran.
4. **What you could not prove**, with the reason and what is missing.
5. **Findings**: defects noticed and not fixed, plan rows corrected, surfaces
   discovered to be missing.
6. **What you deliberately did not do**, so the next person knows the edge of
   the work rather than guessing it.

Do not claim a check passes unless you ran it at the head you are reporting.

## Done means

The finish line runs green at the exact head, the change is the smallest one
that achieves it, no invariant was widened to get there, the plan describes
what is true, and every unproven claim in your report is labelled as such.

A plan, a partially edited tree, a passing focused test, or a stale run is
not completion.
