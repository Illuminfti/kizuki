# Kizuki lane conventions (read fully before touching code)

You are implementing one lane of Kizuki, a local-first TypeScript/Bun CLI+MCP
product: "your life, queryable as a CLI and MCP". Read these first, in order:

1. `docs/CURRENT.md`, `docs/decision-log.md` and
   `rfcs/0002-autonomous-canon.md`. They are binding and override every
   document below, this file and your lane spec wherever they conflict.
   Never restate or reintroduce a superseded policy: owner-invoked promotion
   or an owner review queue or approval step (D9, D10; corrections go through
   MCP `correct` and `kizuki tell`, D14), owner labeling of sensitivity (D11),
   a zero-model floor that writes canon (D12), a SQLite-only rule for derived
   retrieval (D13), or an owner-started daemon (D15).
2. `docs/architecture.md` (the build target; invariants at the top are law,
   as amended by RFC 0002 §2.1)
3. `rfcs/0000-constraints.md` (as amended by RFC 0002 §2.3)
4. Your lane spec's "Decision-log deltas" section, where it has one.
5. The package you are changing: every file under `packages/<pkg>/src` and
   `packages/<pkg>/test`. Match the existing style exactly (naming, error
   classes, `STRICT` tables, transaction usage, test shape).

## Hard rules

- `bun run typecheck && bun test` must be green at every commit. Run both
  before every commit. tsconfig is strict with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `any`, no
  `// @ts-ignore`, no `as unknown as`.
- **Zero new runtime dependencies** unless the lane spec explicitly names one.
  `@kizuki/core` stays dependency-free. Use `bun:sqlite`, `node:fs`,
  `node:path`, `Bun.*` APIs.
- **No network calls anywhere** in product code. Nothing may `fetch`,
  open sockets, or read remote URLs. (Invariant 6: zero phone-home.)
- **Canon is written by the receipted writer** (architecture invariant 3,
  RFC 0002 §2.1; `docs/decision-log.md` D9). Do not add a client, CLI verb,
  TUI key, or scheduled path that writes `.md` files into the vault outside
  the single receipted writer. A scheduled path writing canon is now the
  design, not a violation; a second door is the violation. Today that writer
  is still `packages/core/src/staging/promote.ts` plus
  `packages/core/src/vault/write.ts`. The accepted design moves it to
  `packages/core/src/canon/`. There is no owner review queue and no owner
  approval step, and there never will be one (D10); corrections arrive
  through MCP `correct` and `kizuki tell` (D14). The invariants test in
  `packages/core/test/staging/invariants.test.ts` still scans the public
  write seam; keep it green and do not add a second door.
- **Fail closed**: missing sensitivity label → not served; unknown agent → no
  access; missing credentials → refuse.
- **No fake surfaces**: no CLI verb, registry entry, README claim or doc line
  without a working implementation behind it. If you cannot finish a verb,
  do not wire it.
- **Banned identifiers are the CI denylist in `scripts/verify.sh`.** Never
  write one, in product code, comments, tests, fixtures, documentation,
  tracked paths or commit messages: the scan covers every tracked file and
  every reachable commit message. Use neutral fixture names (ada, grace,
  linus, "acme"). Name no person and no host. The retrieval engine's product
  name may appear only in `README.md` and `docs/upstream-policy.md`, with the
  exact spelling and canonical URL `scripts/verify-attribution.ts` enforces;
  everywhere else write "the retrieval engine (see
  `docs/upstream-policy.md`)".
- Tests use synthetic fixtures only. Never read from paths outside the
  worktree in tests; use `mkdtempSync` temp dirs and clean up.
- Comments explain WHY, never restate the identifier. No banner comments,
  no "TODO" left behind, no dead code, no stubs. Every function you add is
  either used by product code or by a test that exercises real behavior.
- Keep files under ~400 lines; split modules by responsibility.
- Do not touch packages outside your lane's scope unless the spec says so.
- Do not edit `docs/architecture.md` except where the spec says so.

## Git

- Work on the current branch of this worktree only. Never switch branches,
  never rebase, never touch `main`.
- Commit in small, reviewable commits with imperative one-line subjects
  (≤ 72 chars) and a short body explaining why. No co-author trailers.
- Before finishing: `git status --porcelain` must be empty and
  `bun run typecheck && bun test` green on the final commit.
- Do not commit the spec file or any scratch files.

## Definition of done

Every acceptance criterion in the lane spec is verified by a command that
you ran and that passed. Your final message must list: the commands you ran
with their exit status, the test count before and after, and anything in the
spec you deliberately did not do and why.
