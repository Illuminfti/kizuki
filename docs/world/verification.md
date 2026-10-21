# World verification

Run the growing, offline world gate from the repository root with the pinned Bun version:

```bash
bun run verify:world
```

It checks the oracle registry and runs its bound tests alongside the operation,
privacy, purge, resource and interface matrices. A nonzero exit means a gate
failed. The normal repository verification checks the registry and executes
these test files in its full suite.

## Regression controls

Every registered operation must have an explicit scenario. The current matrix
compares response bytes, refusal details, SQL statements/rows and projection
work across all seven hidden mutations. It exercises real source grants and
claim admission, retained references after purge, and allowed reads before
erasure. A deliberately leaky global-count query proves the checker detects a
leak. To demonstrate the failing command boundary:

```bash
bun run verify:world --inject-leak
```

That command must exit nonzero. It uses only temporary synthetic data. There is
no network or production model call.

The parity matrix calls Core, real CLI text and JSON processes, real stdio MCP,
loopback HTTP and the App model for every operation. Only freshly issued,
grammar-checked view, snapshot and sharing capabilities and their expiries are
normalized; evidence, attribution and history contents remain exact.

The scale fixture admits at least 5,000 real claims through the shared writer.
It checks response bytes, verified candidates, examined rows and parsed support
bytes. An overflow must be qualified, not presented as a complete card. These
are work and allocation limits, not latency promises. The existing projection
allows 128 candidates plus an overflow sentinel, 256 KiB output and a separate
2 MiB parsed-support limit. Edge-walk limits have their own identity tests.

## Adding a capability

Add public-operation inputs to `packages/core/test/helpers/world-verification.ts`
and CLI arguments/text checks to the parity test. Missing cases fail the gate.
Bind real oracle fixtures in `rfcs/fixtures/status.ts` and add newly executable
unit identities to `ORACLE_COVERAGE_FLOOR` in `scripts/world-verify/registry.ts`.
Removing an identity from executable coverage fails even if another is added.
An executable entry pointing to a missing or unrelated test also fails.

`--registry-only` checks these registrations without running the tests. Its
result proves registration only.

## Evidence limits

This harness does not establish production activation or authorize model
egress. Held-out model qualification, the copied-vault read-only probe, weekly
verification receipts and the complete longitudinal/golden journeys have
separate acceptance requirements. Until those checks are implemented and run,
they remain outstanding. Newly registered extraction kinds stay disabled for
the producer until held-out qualification passes.
