# Branch protection on main

`main` is a protected branch on GitHub. The protection is repository
settings, not repository content: this page records what it must be, how to
check the live setting, and how to change it deliberately.

## What the protection requires

| Setting | Required value |
| --- | --- |
| Required status checks | `test`, `secrets`, `workflows` (strict, up to date) |
| Required approvals | none; stale approvals are dismissed on new pushes |
| Enforce admins | yes |
| Force pushes | refused |
| Branch deletion | refused |

There is no owner review queue and no approval step here (D9, D10); the
review axis lives in the exact-head review process described in
[AGENTS.md](../AGENTS.md), and merges are gated by the checks above.

The three required contexts are produced by tracked workflows: `test` and
`secrets` by `.github/workflows/ci.yml`, `workflows` by
`.github/workflows/workflows.yml`. `scripts/verify-workflows.ts` fails the
repository gate when a producing job is deleted or renamed, so the workflow
files and the protection settings cannot drift apart silently.

## Verifying the live setting

The tree cannot prove what GitHub enforces. Verify it read-only with
repository admin read access:

```bash
gh api repos/<owner>/<repo>/branches/main/protection
```

`required_status_checks.contexts` must list exactly `test`, `secrets`, and
`workflows`; `enforce_admins.enabled` must be `true`;
`allow_force_pushes.enabled` and `allow_deletions.enabled` must be `false`.
If the live setting is weaker than this page, restoring it is the next
governance fix.

## Exception process

The protection cannot be bypassed by push; it can only be changed by a
repository administrator. Changes go through a pull request:

1. Land the workflow change and the protection change together. Renaming or
   replacing a required job must happen while the old context still reports,
   so required checks never go permanently unreported. An admin updates the
   protection in the same change window.
2. Update `REQUIRED_MAIN_CHECK_JOBS` in `scripts/verify-workflows.ts`, its
   tests, and this page in the same change.
3. For an emergency (a broken required check, a runner outage), an admin may
   temporarily relax one requirement, then must restore it and append the
   reason, affected commits, and window to the log below before anything
   else merges.

## Exception log

- 2026-09-16: audited (KZ-032, issue #106) against snapshot 870ccdca, which
  reported unprotected main. The live protection now matches this page; the
  required-context binding in `scripts/verify-workflows.ts` was added so the
  workflow side of the contract is test-enforced. No exceptions granted.
