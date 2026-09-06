# Contributing

Kizuki is a local-first LifeOS. Read [README.md](README.md) for what the
product is, then [docs/CURRENT.md](docs/CURRENT.md),
[docs/decision-log.md](docs/decision-log.md), and
[rfcs/0002-autonomous-canon.md](rfcs/0002-autonomous-canon.md) before changing
code or docs. Those three override everything else where they conflict.

Do not reintroduce an owner review queue, an owner approval step, owner
labeling of sensitivity, a zero-model path that writes canon, or a
SQLite-only rule for derived retrieval.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| [Bun](https://bun.sh) **1.3.10** | The version CI pins in `.github/workflows/ci.yml` |
| Git | Full history; `bun run verify` refuses a shallow clone |

There is no packaged installer and no `npm i -g kizuki`. Work from a clone.

```bash
bun install --frozen-lockfile
bun packages/cli/src/main.ts help
bun run typecheck
bun test
bun run verify
```

`bun run verify` is the full repository gate: frozen install, typecheck,
tests, policy, network allowlist, and the denylist. A focused test is not
completion.

## Isolation

Assume another person or agent is working at the same time. Use a dedicated
branch. Do not reset, clean, force-push, or rewrite history to make the tree
look clean. Do not amend or merge someone else's pull request.

Before editing:

```bash
git status --short --branch
git fetch origin main
git log -1 --oneline --decorate
```

## What to change

Keep diffs narrow. Public commands, registry entries, schemas, and README
claims must have a working implementation on the same revision. Do not add a
second canon write path. Do not document a leftover `proposals` table as the
owner path. `review`, `promote`, and `reject` stay retired.

Use synthetic fixtures only. Never commit credentials, personal records,
private endpoints, or estate identifiers. The denylist in `scripts/verify.sh`
fails the gate on forbidden identifiers in tracked text and reachable commit
messages.

## Tests

**WSL:** use a clone on the distribution's Linux filesystem (for example,
`~/src/kizuki`) for `bun test` and `bun run verify`. Full-suite verification
from Windows-mounted paths such as `/mnt/c` or `/mnt/d` is unsupported:
filesystem latency can exhaust tree-scan and subprocess test deadlines even
when the same revision passes on the Linux filesystem. Focused checks on
those mounts are useful, but a timeout needs reproduction on the Linux
filesystem before it establishes a regression. Keep existing checkouts and
uncommitted changes intact, test the intended revision, and record its exact
commit and filesystem location. Keep the existing test deadlines.

Prefer a failing public-seam test before the implementation change. Then:

```bash
bun test path/to/file.test.ts
bun test packages/cli/test
bun run typecheck
bun run verify
```

CLI tests drive `packages/cli/src/main.ts` as a process against a temporary
vault. Core tests cover rollback, replay, purge, and provenance. Do not weaken
a test to hide a defect.

## Documentation

Every command, path, and capability claim must match the live tree. Separate
implemented behavior from accepted design. 1.0 is stranger proof plus estate
cutover; neither is done. Do not invent an installer, a docs site, or a
packaged binary.

Agent playbooks live under `.agents/skills/`. [AGENTS.md](AGENTS.md) is
repository policy.

## License

Contributions land under [MIT](LICENSE).
