# Retained world history

This implementation adds recorded-time reads to the existing world-view contract.
It implements a bounded slice of RFC 0004 and its proposed temporal amendment; it
does not change their decision status or imply that the whole RFC has shipped.

## Public operations

`concept` and `situation` accept the existing `knownAt` union: `current`, `time`,
or `snapshot`. A successful time read returns `knownAt: {kind: "snapshot", ref}`
in its card. `history` takes a `concept` object reference, `valid`, `knownAt`, and
optional `priorView`; it returns `kizuki.world-history/v1` with its snapshot,
qualified state transitions, opaque causing receipts where retained, and coverage.
The CLI exposes `--known-at TIME`, `--snapshot TOKEN`, and `--valid-at TIME` on
these operations. MCP and the existing HTTP/App registry expose the same inputs.

A timestamp resolves once to the latest committed history position at or before
that instant. Final authorization rechecks may reproject the answer, but retain
that first cutoff. Equal or backward wall clocks therefore cannot admit a later
transaction into an already resolved read. A new timestamp request is a new
resolution; use the returned snapshot to repeat the old cutoff.

For example, a claim valid Monday but first admitted Wednesday is absent from
Tuesday's known state. Complete history proves that absence. A migrated or
partially erased baseline cannot prove the earlier state, so a fresh timestamp
before that boundary returns `unavailable` with reason `history`. Missing or
invalid snapshot capabilities uniformly return `new_view_required`.

## Authorization and retention

Every historical claim and supporting admission must exist by the cutoff and
remain usable under current source consent, sensitivity classes, principal grant,
purpose, endpoint proofs and corroboration holds. Historical superseded/reverted
claims may be read when their retained state warrants it. Current reads still
require live claims. The final dependency check revalidates these boundaries and
retained history; it never uses a global sequence as a freshness signal.

Snapshots reuse the VIEW cache: 32 random bytes, a domain-separated lookup hash,
current principal namespace, source purpose, normalized object identity, and a
valid-time scope that may be narrowed but not widened. Views and snapshots share
16 slots, 4 MiB per principal, 256 KiB per entry and a 15-minute TTL. A read issuing
both reserves two slots before publishing either. The cutoff lives only in the
private cache payload; it is absent from public references, bodies and cache
fingerprints. Unreserved principals can still read current cards; timestamp reads
that cannot retain their cutoff report history unavailable.

Purge cascades invalidate dependent snapshots. Partial evidence loss replaces the
claim's retained coverage boundary, so even an old snapshot whose selected
support survived cannot reconstruct the discarded history. Restart, restore,
expiry, quota eviction and policy changes may invalidate capabilities. Snapshots
are deliberately not durable bookmarks.

## Storage and limits

The durable clock, support admissions, lifecycle transitions and coverage remain
in the existing history foundation. The following migration adds only cached,
namespace-bound receipt-reference mappings with claim/history/receipt erasure
edges. Backup omits that cache; restore and rebuild recreate it empty. No second
temporal authority store is introduced.

History pages contain at most 128 transitions. Current authorization, admitted
support cutoff and valid-time selection precede that limit. A larger permitted
page explicitly reports the traversal limit. Model calls and reconstruction from
source timestamps are never used. Non-current discovery, sharing and resumption
remain unavailable until their own contract carries the required temporal scope;
this slice does not invent a new wire shape for them.

## Verification

Run from the checkout with the repository's shared test semaphore and private
`TMPDIR`:

```bash
bun test packages/core/test/serving/world-known.test.ts \
  packages/core/test/world/known-history.test.ts \
  packages/core/test/world/known-snapshots.test.ts \
  packages/core/test/world/table-versions.test.ts
bun test packages/mcp/test/world.test.ts packages/mcp/test/world-ops.test.ts \
  packages/cli/test/world.test.ts packages/cli/test/world-ops.test.ts
bun run typecheck
```

The tests exercise the public serving gate, actual MCP client and CLI process,
correction/undo receipt identity, late support, clock ties, baseline gaps, consent
revocation, physical and partial erasure, final authorization races, bounded
history, namespace/scope rejection and shared cache reservation.
