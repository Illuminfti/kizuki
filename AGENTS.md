# Kizuki agent instructions

This is the authoritative repository instruction file for coding agents. Read it
before inspecting or changing code. Then read every nearer `AGENTS.md` between
the repository root and the files you will touch. A nearer file adds or narrows
rules for that subtree; it does not cancel the root safety and product
invariants.

These instructions are harness-neutral. Client-specific entry files must point
back here rather than grow independent policy.

## Start here

Before proposing work, read:

1. `docs/architecture.md`.
2. `rfcs/0000-constraints.md`.
3. Any other merged RFC that governs the area.
4. `docs/product-context.md` when it exists on the checked-out revision.
5. The nearest scoped `AGENTS.md`.
6. The relevant skill under `.agents/skills/`.

For active campaign context, inspect the live issue and pull-request state.
While issue #4 is open and not superseded, treat it as the durable handoff.
Do not copy an old issue body, branch head, or test count into a new claim
without checking it again.

## What Kizuki is

Kizuki is a local-first personal intelligence substrate. It is not an agent
harness and does not own an agent loop. Connectors and imports produce
source-linked evidence. Evidence enters an append-only ledger, becomes staged
proposals, and reaches durable Markdown canon only through owner-invoked
promotion. Search, graph, timeline, and other derived layers must remain
rebuildable. Agents and harnesses are replaceable clients with scoped identity,
grants, rate limits, and audit.

Always distinguish among:

- **implemented behavior**, proved by code and tests on the current revision;
- **accepted design**, recorded in merged binding RFCs and architecture;
- **direction or future vision**, which must never be presented as shipped.

When documentation, code, and tests disagree, do not quietly pick the most
convenient source. State the mismatch and either reconcile it within the task
or leave a precise blocker.

## Non-negotiable invariants

Preserve these across every change:

1. Canon is human-readable Markdown on the owner's disk.
2. Only owner-invoked promotion may write canon. Agents and automation propose.
3. The event ledger is append-only. Purge is physical deletion with a receipt.
4. Derived state is disposable and reproducibly rebuildable.
5. The deterministic, zero-model path remains useful. LLM behavior is additive
   or gracefully skippable.
6. No silent network egress. Runtime network access is limited to explicit,
   user-configured connectors and model endpoints.
7. Captured text, metadata, filenames, archives, and provider responses are
   attacker-controlled input. Keep evidence separate from trusted instruction.
8. Missing identity, grant, scope, sensitivity, credential, or provenance
   information fails closed.
9. Credentials remain behind supported secret references. Never persist
   plaintext credentials in SQLite, logs, fixtures, snapshots, or Markdown.
10. Every public command, registry entry, schema, documentation claim, and
    advertised capability must have a working implementation behind it.
11. Subject identity, provenance, correction, supersession, revocation, and
    purge behavior remain reversible and testable.
12. Durable state must fit the repository's local TypeScript, Bun, SQLite, and
    Markdown architecture unless a merged RFC explicitly changes that boundary.

## Multi-agent coordination

Assume another person or agent may be working at the same time.

### Never damage work you did not create

- Treat unfamiliar branches, worktrees, commits, files, and uncommitted changes
  as someone else's work.
- Do not use `git reset --hard`, `git clean`, broad checkout/restore commands,
  force-push, history rewriting, or stash manipulation to make the tree look
  clean.
- Do not delete or commit a local `.maestro/` directory. If it exists, preserve
  it exactly unless the owner gives a separate, explicit instruction.
- Do not amend, rebase, merge, mark ready, close, or merge another agent's pull
  request without explicit authority and an exact-head review.
- Do not share a mutable branch or worktree unless the task explicitly requires
  it.

### Isolate the lane

Use a dedicated branch and, when local work already exists, a dedicated
worktree based on the intended remote base. Pick a descriptive namespace such
as `agent/<topic>` or the harness's established prefix. Keep the diff narrowly
owned and avoid drive-by formatting.

Before editing:

```bash
git status --short --branch
git rev-parse --show-toplevel
git rev-parse HEAD
git fetch --prune
git log -1 --oneline --decorate
git diff --name-only
git diff --cached --name-only
```

When GitHub access is available, also inspect the current handoff, open pull
requests, their changed files, and recent commits. With GitHub CLI this is
typically:

```bash
gh issue view 4
gh pr list --state open
gh pr view <number> --json headRefName,headRefOid,baseRefName,isDraft,files
```

If GitHub access is unavailable, say so in the handoff. Do not claim that local
remote-tracking refs represent live state.

If another lane touches the same contract or path, coordinate through the
existing issue or pull request when authorized. Otherwise change scope or stop
at a clearly described dependency. Parallel work that merely compiles in
isolation is not integrated work.

### Re-check before every consequential step

Immediately before committing or pushing:

1. Fetch the target base again.
2. Compare the base recorded at task start with the live base.
3. Check whether upstream changed any path or public contract in your diff.
4. Rebase or reconstruct only your own branch.
5. Rerun the required verification on the resulting exact head.
6. Record the exact head SHA and command receipts.

A passing test run from an earlier SHA is not evidence for the current head.

## Repository map

- `packages/core`: contracts, ledger, staging, vault, query, agent policy, and
  rebuildable derived layers. This is the main invariant boundary.
- `packages/connectors`: connector interface, registry, imports, normalization,
  and conformance tests.
- `packages/cli`: command-line composition over public core and connector APIs.
- `packages/tui`: owner review interface, pure state transitions and rendering,
  with terminal effects at the edge.
- `docs`: architecture and explanatory product documentation.
- `rfcs`: proposed and binding design decisions. Status in each RFC matters.
- `.github`: CI and repository automation.
- `.agents/skills`: canonical task playbooks for agents.
- `.claude/skills`: discovery adapters that point to the canonical skills.

Do not infer a capability from a directory name. Inspect exports, call sites,
tests, and the current revision.

## Tooling

The workspace uses TypeScript in strict mode and Bun. Inspect `package.json`,
the lockfile, and CI on the checked-out revision before running commands. Match
the Bun version pinned by the branch or handoff under review.

Prefer repository-provided scripts. When `bun run verify` exists, it is the
full repository gate. On revisions without that script, the baseline is:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
git diff --check
```

Useful focused forms include:

```bash
bun test packages/core/test
bun test packages/connectors/test
bun test packages/cli/test
bun test packages/tui/test
bun test path/to/file.test.ts
```

Do not add a dependency, global tool, generated framework, network service, or
build step merely for agent convenience. Use `rg`, `git grep`, `git diff`,
`git log`, and existing Bun tooling where available. Inspect SQLite through
the repository's public database helpers and synthetic temporary vaults; do
not open an owner's real vault or runtime database unless explicitly asked.

## Implementation workflow

1. **Orient.** Run the preflight, read governing instructions, map public seams,
   and identify overlapping active work.
2. **Define the contract.** State the behavior, failure mode, invariants, and
   evidence that will prove completion.
3. **Reproduce first.** For a defect, create the smallest reliable reproduction.
   For new behavior, locate the public seam and specify an acceptance example.
4. **Test first when practical.** Add a failing regression or characterization
   test before changing implementation. Never weaken a test to make a defect
   disappear.
5. **Make the smallest coherent change.** Preserve existing public contracts
   unless the task and a governing RFC require a change.
6. **Test from narrow to broad.** Run the focused test, package tests,
   typecheck, then the full repository gate.
7. **Review the diff as an attacker and maintainer.** Check rollback, retries,
   partial failure, untrusted input, information leakage, compatibility,
   performance bounds, and misleading claims.
8. **Rebase on live state.** Resolve only your lane's conflicts and rerun every
   required gate on the exact head.
9. **Leave receipts.** Report exact commands, results, head SHA, remaining
   uncertainty, dependencies, and intentionally untouched work.

### Coding standards

- Keep core logic deterministic, explicit, and easy to test.
- Prefer small typed functions and clear domain types over hidden global state.
- Validate at trust boundaries and preserve original provenance.
- Use transactions for multi-row state changes. Design file changes for
  complete writes, atomic replacement, durability, rollback, and recovery.
- Make retries idempotent. Test duplicate delivery, interruption, stale state,
  and replay.
- Bound scans, recursion, result counts, context size, and user-controlled
  allocation.
- Avoid catch-all error suppression. Preserve causes without leaking secrets or
  captured private text.
- Keep public errors stable and actionable. Send machine-readable output to
  stdout only when the command promises it; diagnostics belong on stderr.
- Do not introduce a second implementation of an existing contract.
- Do not perform unrelated refactors in a behavior fix.
- Do not turn a future design into placeholder production surface.

## Required verification by area

### Core and storage

Test happy path plus transaction rollback, restart or recovery, duplicate
delivery, stale capabilities, mismatched identities, purge cascade,
provenance, migration from every supported schema, and rebuild equivalence.
Any schema change needs migration and fresh-database coverage.

### Connectors

Run the shared conformance suite and provider-specific tests. Prove credential
failure is closed, fixtures are synthetic, backfill is idempotent, checkpoints
resume correctly, source deletion becomes a tombstone, revoke and purge are
honest, and auth behavior matches sanctioned provider documentation.

### CLI

Test the public command seam end to end with temporary state. Cover argument
errors, exit codes, stdout/stderr separation, safe redaction, repeated calls,
and failure cleanup. The CLI must not bypass core policy.

### TUI

Keep reducers and rendering pure. Test every key path without requiring a TTY.
Treat all displayed capture as hostile, strip control sequences, preserve
owner confirmation, and never create another canon write path.

### Documentation and RFCs

Verify links, paths, command examples, schema names, Mermaid fences, and claims
against the exact revision. Mark shipped, accepted design, and future direction
clearly. An RFC binds only when its status and merge state say it does.

### Security-sensitive work

Run the privacy and security skill. Exercise denial paths, scope filters,
sensitivity ceilings, audit redaction, token handling, path traversal, archive
and symlink behavior, malformed input, resource exhaustion, and network
egress. Security tests must prove both allowed and forbidden behavior.

## Reviews

A merge recommendation requires two explicit review axes on the exact head:

1. **Specification and security:** Does the change satisfy the task, binding
   RFCs, architecture, privacy model, authority boundary, and failure semantics?
2. **Implementation quality and regression:** Is the code correct under retries,
   concurrency, partial failure, migration, malformed input, and integration
   with existing callers?

Report findings before summaries. Use severity, file and line, concrete failure,
and a reproducible example. Do not approve because CI is green, and do not
reuse approval after the head moves.

## Data, privacy, and external research

Use only synthetic, neutral fixtures. Never copy personal records, message
bodies, credentials, tokens, private endpoints, browser state, logs, databases,
or machine-specific deployment paths into the repository, an issue, a pull
request, or model context.

Provider APIs, authentication rules, prices, quotas, licenses, and SDK behavior
are time-sensitive. For connector or dependency work, verify current primary
documentation and record the check date and honest limitations. Never scrape,
use unofficial access, or describe an export importer as live sync.

## Commits, pull requests, and handoffs

- Keep commits coherent, reviewable, and written in imperative language.
- A draft pull request is the safest early coordination surface when the owner
  has authorized one. It is not a claim of completion.
- The pull request body must state purpose, scope, exact base and head, changed
  contracts, tests run, security/privacy impact, dependencies, and blockers.
- Keep a pull request draft until its stated acceptance gates pass.
- Never merge, deploy, publish, create releases, rotate credentials, or change
  repository settings without explicit authority for that action.
- Before a session boundary, use the handoff skill. Preserve work in a branch,
  distinguish committed from local-only state, and never claim unseen or
  interrupted work as complete.

## Skills

Open the matching canonical playbook before performing the task:

| Task | Skill |
| --- | --- |
| Establish live context and collision risk | `.agents/skills/orient-repository/SKILL.md` |
| Implement or repair a bounded change | `.agents/skills/implement-change/SKILL.md` |
| Diagnose a failure without shotgun edits | `.agents/skills/diagnose-failure/SKILL.md` |
| Review a branch or pull request | `.agents/skills/review-change/SKILL.md` |
| Add or change a connector | `.agents/skills/connector-work/SKILL.md` |
| Audit privacy and security boundaries | `.agents/skills/security-privacy-review/SKILL.md` |
| Write or revise a design RFC | `.agents/skills/write-rfc/SKILL.md` |
| Stop cleanly or transfer work | `.agents/skills/handoff-work/SKILL.md` |

Use the smallest set that covers the task. `orient-repository` comes first for
all non-trivial work; `handoff-work` comes last when work continues elsewhere.

## Definition of done

Work is done only when the requested behavior exists at the public seam, tests
prove the important success and failure cases, the exact head passes required
gates, documentation makes no unsupported claim, no concurrent work was lost
or overwritten, and the handoff contains reproducible receipts. A plan,
partially edited tree, passing focused test, or stale CI run is not completion.
