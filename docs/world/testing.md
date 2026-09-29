# World test kit

This page is for contributors who add a world-model operation, kind or control
and need to prove it the same way every other workstream does. It describes
what exists on the integration head, what each piece cannot do yet, and how to
promote a design fixture once a product test binds it.

Everything here is test infrastructure. Nothing in this kit ships in a
package, adds a table, or changes a public contract.

## What the kit provides

| Piece | Path | Use it to |
| --- | --- | --- |
| Fixture status registry | `rfcs/fixtures/status.ts` | Say which design fixtures are executable and which wait for an owner. |
| Oracle coverage table | `rfcs/fixtures/oracle-coverage.ts` | List every oracle unit as executable, or deferred with an owner key. |
| World seed | `packages/core/test/helpers/world-seed.ts` | Store a world object of any kind from a predicate list. |
| Test clock | `packages/core/test/helpers/clock.ts` | Set `asserted_at` exactly, with no sleep. |
| Noninterference driver | `packages/core/test/helpers/noninterference.ts` | Prove hidden evidence changes no output byte, error or work counter. |
| Concept scenario | `packages/core/test/helpers/world-kit/scenario.ts` | Build the concept design fixture in a real ledger and run its controls. |
| Loopback helper | `packages/core/test/helpers/world-kit/loopback.ts` | Call the standing HTTP endpoint on 127.0.0.1. |
| Two clients | `packages/mcp/test/helpers/two-clients.ts` | Run one `world_view` read for the owner and a scoped agent over real stdio. |

## Promote a design fixture

A design fixture never calls product code. Its own `status` stays
`future_unimplemented`; the registry says whether a real test binds it.

1. Write the test that runs the fixture's scenario against the product at a
   public seam (Core, stdio MCP, loopback HTTP, CLI or the App).
2. In `rfcs/fixtures/status.ts`, replace `deferred("OWNER")` with
   `executable("path/to/that.test.ts")` for the fixture id. The path must be a
   `.test.ts` file under `rfcs/` or `packages/*/test/` whose text names the
   fixture id, and never one of the registry's own files. For the concept and
   longitudinal fixtures, do the same on each assertion line in
   `ORACLE_ASSERTION_STATUS`.
3. Run `bun test rfcs/fixtures`. The registry test fails if the named file does
   not exist, and the coverage test prints the new executable count.

The design tests and `validate-world-design.ts` call `fixtureStatusErrors`
instead of comparing a string, so promotion never touches them.

## Prove noninterference

`assertNoninterference({ cases })` builds a fresh scene per hidden mutation: a
narrow reader that sees two public objects, and private evidence in a source
its grant cannot reach. For each mutation it reads every case, applies the
mutation, reads again, and compares three things.

- Bytes: the canonical output, where only `at` values and the `token` of a wire
  ref are normalized. Every other string, including a digest or etag, stays
  byte-exact.
- Error: the class, code and text of a refusal.
- Stats: work counters. Until the projection reports its own frame statistics,
  the counters are the SQL statements the read ran on its connection and the
  rows those statements returned, so a broad query filtered afterwards in
  memory is still seen. A case can return richer counters through its `stats`
  hook.

The seven mutations are a hidden claim, source revoke, purge, identity merge,
owner correction, supersession and dependency edge. Add a read operation by
returning one more `ReadCase` from `cases`:

```ts
await assertNoninterference({
  cases: (scene) => [...worldViewCases(scene), myCase(scene)],
});
```

The driver proves it can fail: `LEAKY_GLOBAL_COUNT` answers with global row
counts and must be reported, and a visible change on the real world cases must
be reported too, so a pass is not vacuous. Wall-clock timing is not promised; equal counters
are the timing proxy, matching RFC 0004.

## Seed and time

`worldSeed(db, { kind, subject, label, predicates, clock })` stores the event
and claims for one object. With default options it stores what `worldFixture`
stores for a Concept or Situation. Pass `predicates` to store any claim set
the writer accepts, and `clock` to fix `asserted_at` and `admitted_at`:

```ts
const clock = testClock("2026-03-01T09:00:00.000Z");
await worldSeed(db, { clock });
clock.advance(90_000);
```

A refused predicate stops the seed at once and is not atomic: the event and the
claims written before it stay in the ledger. Time only moves forward. Capture time (`accepted_at`) is the ledger's wall
clock and cannot be driven from a test, so known-at tests fix claim times, not
capture times.

## Real clients

`twoClients()` starts the owner and a scoped agent as separate stdio
processes on one vault and returns their audit rows. `startLoopback(db,
vaultPath)` starts the standing HTTP endpoint and returns a `post` helper that
takes the owner token or an agent's bearer (`agentToken` from `twoClients`). Both
are the only new call sites for a process transport or `fetch` in the world
tests; reuse them rather than adding more.

## Limits on this head

- The concept scenario builds sources, grants, principals and captured
  records, and runs source revocation, exact raw purge and grant narrowing.
  Identity confirmation, consolidation jobs and the exact-claim correction throw
  `ScenarioDeferred` naming their owner, because their product operations do not
  exist yet. Scheduled admissions are not built for the same reason.
- No oracle assertion is executable yet. The coverage table reports that
  plainly and names an owner for each unit.
- The counters change only when a read runs different SQL or returns different
  rows. They do not see work done in memory on the same rows. The projection
  frame statistics replace them.

## Verify

```bash
bun test rfcs/fixtures
bun test packages/core/test/serving/world-seed.test.ts
bun test packages/core/test/serving/world-noninterference.test.ts
bun test packages/core/test/serving/world-scenario.test.ts
bun test packages/mcp/test/two-clients.test.ts
```
