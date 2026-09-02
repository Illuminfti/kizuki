# Contributing

## Before you start

Read [AGENTS.md](AGENTS.md) first. It is the policy: what Kizuki is, the
invariants no change may break, and the rules for working alongside other
people and agents. This file is only the workflow.

Then read [docs/architecture.md](docs/architecture.md) and
[rfcs/0000-constraints.md](rfcs/0000-constraints.md). A design that contradicts
either is a request for an RFC, not a pull request.

## Set up

Kizuki is one Bun workspace. CI pins Bun 1.3.10; a newer local Bun is fine as
long as the frozen install and the tests pass.

```
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify
```

`bun run verify` is the gate. Run it before you push, not after review asks.

## The gates

`bun run verify` runs `scripts/verify.sh`, and every step below fails the whole
run:

| Step                  | What makes it fail                                                                            | Proof                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Frozen install        | The lockfile disagrees with any manifest                                                      | `run: bun run verify`                                                               |
| Typecheck             | Any type error under the strict config, including an unchecked index                          | `run: bun run typecheck`                                                            |
| Tests                 | Any failing test in any package                                                               | `run: bun run test`                                                                 |
| Policy tests          | The repository's own policy assertions regress                                                | `run: bash scripts/verify-policy.test.sh`                                           |
| Network scan          | A source file under `packages/` can open a socket                                             | `run: bun scripts/verify-network.ts`                                                |
| Documentation gate    | A link, anchor, Mermaid fence, or proof token stops resolving                                 | `run: bun run verify:docs`                                                          |
| Telemetry grep        | A tracked manifest names a known telemetry package                                            | `scripts/verify.sh::phone-home dependency`                                          |
| Identifier denylist   | A private identifier appears in tracked text, a tracked path, or any reachable commit message | `scripts/verify.sh::forbidden identifier in reachable commit messages`              |
| Attribution validator | A credited upstream is misspelled, or its URL is not the exact canonical one                  | `scripts/verify-attribution.ts::public attribution does not use the exact spelling` |

Two of those deserve a plain warning.

**The identifier denylist** rejects a fixed list of private names anywhere in
the repository: tracked file contents, tracked paths, and every commit message
reachable from any branch. The list lives in `scripts/verify.sh` and nowhere
else; do not copy it into another file. In practice: never write the name of a
person, a machine, a private deployment, or an upstream product other than the
ones credited in [docs/upstream-policy.md](docs/upstream-policy.md), and never
write this repository's own URL or `owner/repo` slug. Use relative links.

**A commit message cannot be un-written.** The denylist scans history, so a bad
identifier in an old commit fails CI until that history is rewritten. Check the
subject before you commit, not before you push.

Use the neutral fixture names the tests already use: `ada`, `grace`, `linus`,
`acme`.

## Branches and pull requests

- Branch from the default branch. Name it `agent/<topic>` or something equally
  descriptive.
- Keep the pull request draft until `bun run verify` is green on the exact head
  you pushed. A green run on an earlier commit proves nothing.
- Fill in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
  The base and head SHA and the commands you actually ran are the parts a
  reviewer cannot reconstruct.
- Reviews run on two axes, described in [AGENTS.md](AGENTS.md): does the change
  do what it claims, and does it hold the invariants.
- Do not merge without authority, and never touch someone else's branch,
  worktree, or pull request.

## Commits

- Imperative subject, 72 characters or fewer.
- A short body saying why, not what; the diff says what.
- No co-author or generated-by trailers.
- Small, reviewable commits. A commit that both moves a file and changes its
  behavior is two commits.

## Code rules

Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
and `verbatimModuleSyntax`; no `any`, no type-checker suppressions. Zero new
runtime dependencies unless a merged design names one, and `@kizuki/core` stays
dependency-free: reach for `bun:sqlite`, `node:fs`, `node:path` and `Bun.*`
first. No network call anywhere in product code. Fail closed, everywhere:
missing sensitivity means not served, unknown agent means no access, missing
credential means the connector refuses. No fake surface: no CLI verb, registry
entry, or documented claim without an implementation behind it. Keep files
under roughly 400 lines and split by responsibility. Tests use `mkdtempSync`
temp directories, synthetic fixtures, and clean up after themselves; a test
that reads a path outside the worktree is a bug.

## Documentation rules

Every capability table in the README, and any table anywhere with a `Proof`
column, must fill that column with backticked proof tokens:

- `` `path/to/file.ts` `` — a tracked file.
- `` `path/to/file.test.ts::exact test title` `` — a tracked file that contains
  that literal string. Use the real `test()` or `describe()` title.
- `` `run: bun run <script>` `` — a script in the root `package.json`.
- `` `run: bash scripts/<file>` ``, `` `run: bun scripts/<file>` ``, or
  `` `run: bun packages/<pkg>/src/<file>` `` — a tracked file to execute.

A row that asserts one behavior names the test title. A row that summarizes a
module may name the whole test file. A claim with no proof token is not a claim
you can write here.

Keep the three status words apart, and never let a sentence drift between them:
**what runs today** is proved by code and tests on this revision; **accepted
design** is recorded in the architecture or a merged RFC and does not run;
**direction** is product intent and may never appear as shipped.

`bun run verify:docs` checks all of it: every relative link and anchor resolves
to a tracked file and a real heading, every Mermaid fence is the dialect GitHub
renders, and every proof token still resolves. Consequences you will meet:

- adding a CLI verb means adding its row to the README verb table;
- adding a registry connector means adding its row and its section to
  [docs/connectors.md](docs/connectors.md), plus a fixture config in
  `packages/connectors/test/docs.test.ts`;
- renaming a test breaks every document that cited it, on purpose.

## Adding a connector

Follow the `connector-work` skill under `.agents/skills/`. In short:

1. Use the provider's sanctioned authentication. No scraping, no unofficial
   endpoint, no borrowed session.
2. Build a stable `source_record_id` and deterministic normalization, so the
   same source record hashes the same way twice.
3. Ship an offline fixture; no connector test may touch the network.
4. Pass the shared conformance suite in `packages/connectors/src/conformance.ts`.
5. Emit tombstones, or document precisely why the provider makes that
   impossible, and plan what a subject purge removes.
6. Keep credentials behind secret references, redact what you log, and add the
   registry entry last — after the implementation and the docs row.

Name the source honestly: live sync, local loopback, folder snapshot, or export
import. An export importer is never called sync.

## Adding a dependency

Use the `dependency-evaluation` skill and record the seven-item evaluation from
[docs/upstream-policy.md](docs/upstream-policy.md) in the pull request: name and
canonical URL, the capability needed and the evidence it supplies, license and
notice duties, the declared boundary, privacy and network behavior,
fixture-based acceptance and failure tests, and the upstream contribution plan.
Pin an exact version. "It is popular" is not an evaluation.

## Design changes

Design lives in [rfcs/](rfcs/). Use the `write-rfc` skill, keep the RFC to
concrete schemas and worked examples, and remember that an RFC binds only when
it is merged and its status says so.

## Security

Read [SECURITY.md](SECURITY.md) before touching authorization, credentials,
purge, or anything a connector captures. Report a suspected vulnerability the
way that file describes; never in an issue or a pull request. Never test
against a real vault.

## License

Kizuki is MIT; see [LICENSE](LICENSE). Contributions are accepted under the
same license.
