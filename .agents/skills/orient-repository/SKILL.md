---
name: orient-repository
description: Establish live repository context, governing instructions, active work, and collision risk before any non-trivial Kizuki task. Use at the start of implementation, review, debugging, planning, or handoff recovery.
---

# Orient repository

## Goal

Produce a compact, evidence-backed orientation note before changing anything.

## Steps

1. Locate the repository root and read root plus nearest scoped `AGENTS.md`.
2. Read `docs/architecture.md`, binding RFCs for the area, and
   `docs/product-context.md` when present.
3. Record current branch, exact head, configured remotes, dirty state, staged
   state, untracked paths, and worktrees.
4. Fetch the intended base when network access and authority allow it.
5. Inspect the live handoff, open pull requests, changed files, recent commits,
   and CI status. Treat local refs as stale until verified.
6. Map the task to public seams, tests, data stores, and security boundaries.
7. Compare proposed paths and contracts with every active lane.
8. Identify available package scripts and the exact verification entrypoint for
   this revision.
9. State what will be touched, what will not be touched, dependencies, and any
   unresolved overlap.

## Safe commands

```bash
git status --short --branch
git rev-parse --show-toplevel
git rev-parse HEAD
git remote -v
git worktree list
git diff --name-status
git diff --cached --name-status
git fetch --prune
git log --oneline --decorate -12
```

Use `gh issue view`, `gh pr list`, and `gh pr view --json ...` only when GitHub
CLI is configured. Read-only inspection does not imply permission to comment,
create, close, mark ready, or merge.

## Output

Return:

- exact local head and intended base;
- whether remote state was verified and when;
- applicable instructions and RFCs;
- public seam and relevant tests;
- active overlap by branch, pull request, path, or contract;
- safe isolated branch or worktree choice;
- verification commands for this revision;
- blockers and assumptions.

Do not edit until collision risk is understood.
