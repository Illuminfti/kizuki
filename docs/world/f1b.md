# World projection pipeline and card kit

Status: implemented on this branch; pending integration. Evidence date: 2026-09-30.

`projectWorldCard` and `discoverWorld` keep their signatures and now wrap a pipeline in `packages/core/src/world/pipeline`. A new kind, enricher, collector or grouper is a new file or one registered line, not an edit to `world/projection.ts`. For concept and situation the served bytes are unchanged; golden traces pin that (see Tests).

## The stages

A card read runs group, collect, enrich and assemble. A discovery page collects eligible classifications, groups their authorized members, filters their combined labels and assembles the page.

| Stage    | File                   | What it does                                                                                                                                                                        | List and slot markers                                                            |
| -------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| group    | `pipeline/group.ts`    | Starts from the requested handle as a cluster of one and lets each grouper widen it. The handle stays the anchor.                                                                   | `GROUPERS`: `ident`                                                              |
| collect  | `pipeline/collect.ts`  | Asks each collector for candidate claim ids, then verifies every id with `eligibleWorldClaim`. A collector says where to look and proves nothing. Also scans handles for discovery. | `COLLECTORS`: `ident`                                                            |
| enrich   | `pipeline/enrich.ts`   | Projects each eligible claim to a wire `Relation`, then hands the body to each enricher in order.                                                                                   | `ENRICHERS` in `pipeline/enrichers.ts`: `card`, `consol`                         |
| assemble | `pipeline/assemble.ts` | Builds the node, labels and coverage once, then calls the assembler of the kind. For discovery it sorts the page, issues the cursor and sets coverage.                              | `KIND_ASSEMBLERS` in `kinds/index.ts`: `quest`, `people`, `skill`, `sit2`, `art` |

`pipeline/read.ts` runs them: `readWorldCard(frame, handle, kindId)` and `readWorldMatches(frame, kindId, label, after, scanBudget)`. `eligibleWorldClaim` moved to `pipeline/eligible.ts`, and `relation` and `objectRef` to `world/relation.ts`. `world/projection.ts` re-exports every name other modules import from it.

Kinds come from the vocabulary registry. Discovery reads the label predicate and the classification value from the kind's `WorldKindSpec`, so a registered kind needs no change here.

## ReadFrame

Every read opens a `ReadFrame`: the reader (`ctx`), its reference namespace, the valid window, the recorded cutoff, the parse budget and `stats`. `stats.rowsExamined` counts the rows the collect stage read from the ledger. `stats.claimsVerified` counts claims put through `eligibleWorldClaim`. Wall-clock time is not promised, so these counters are the timing proxy: they must not move when a reader cannot see the evidence that changed.

The cutoff is `{kind: "current"}`. A `knownAt` time or snapshot is still refused before a frame exists, with `unavailable` and reason `history`. Known-at history widens the cutoff type and `claimVisibleSql`, the one place the pipeline names a claim status in SQL.

## Add to the pipeline

An enricher fills in what the base projection leaves `unknown`. It receives the `CardBody` (claims with their relations, extra gaps, summary) and returns it refined. It may change a relation, add a gap or set the summary. It may not add, drop or reorder a claim; the pipeline refuses that. A gap it adds makes the card partial.

1. Write the enricher in a new file.
2. Add one line under your marker in `pipeline/enrichers.ts`.

A collector returns candidate claim ids for a cluster. Add one line under `ident` in `COLLECTORS`. A grouper takes a cluster and returns a wider one with a resolution; add one line under `ident` in `GROUPERS`. Collected ids are verified and a cluster that loses its anchor is refused.

The built-in card collector prioritizes the requested anchor's classification and labels, then merges the remaining candidates by predicate priority and claim ID. Member order cannot let a saturated alias hide the requested card. Claims beyond the shared limit produce partial coverage with `traversal_limit`. Grouped discovery allows at most 256 combined labels per match; exceeding that wire bound returns `unavailable` with reason `budget` through Core and MCP.

Discovery uses the same groupers. Proposed members must have an eligible asserted classification of the requested kind before their labels or handles influence the page. Claim type and asserted-time grant limits apply in SQL before candidate limits and work counters, as do support-event grants. Discovery counts eligible classifications before label filtering, so an unrelated label query does not make a populated kind look dark. A group has at most 128 authorized members; exceeding that bound returns the existing budget fallback. The smallest authorized handle represents a group consistently across pages, and a search can match any member's label. A grouper must return the same full component for each member under the same frame; directional membership hints do not define a discovery group. Groupers must derive membership from authorized evidence: returning hidden membership hints is not a substitute for passing the noninterference driver.

A kind needs its vocabulary module (see [the vocabulary registry note](f4.md)), a card file built on the card kit, and an assembler:

1. Add `contracts/<kind>-card.ts` on the card kit.
2. Add `world/kinds/<kind>.ts` exporting a `KindAssembler`. It lays out the fields of the card from the `CardInput` and ends with `sealCard`, which refuses an oversize card and one its own codec rejects.
3. Add one line under your marker in `kinds/index.ts`.

A registered kind with no assembler has no card to serve.

## The card kit

`contracts/world-card-kit.ts` holds what every card codec repeated: the wire reference, the qualified relation, the knowledge node, coverage, the strict validators for them, and `cardCodec`. `cardCodec` takes a schema id, a label and one validator per field, and returns a closed validator. The card must have exactly `schema` plus those fields, each passing its check. Any failure is the same fixed refusal, `invalid <label>/v1 payload`, and the input is snapshotted within fixed bounds first.

`concept-card` and `situation-card` publish the same names as before and declare only their own shape. The kit is not exported from the contracts index.

## Honest fallbacks

- An empty first page of discovery for a registered kind that no build path can fill is `partial` with the gap `coverage`, never `complete_for_query`. A kind can be filled when it lists a path other than `extraction`, or lists `extraction` and is offered to the extraction model. The rule applies only when the reader can see no handle of that kind, so a kind that holds claims, or a page past the first, is not affected. Concept and situation are offered, so their pages are unchanged.
- A `knownAt` time or snapshot returns `unavailable` with reason `history`, exactly as before.
- A summary, conflict and independence stay `null` and `unknown` until an enricher that proves them is registered.

## Tests

```bash
bun test packages/core/test/world/pipeline-golden.test.ts
bun test packages/core/test/world/pipeline.test.ts packages/core/test/world/pipeline-noninterference.test.ts
bun test packages/core/test/world/pipeline-kinds.test.ts packages/core/test/world/discovery-population.test.ts
bun test packages/core/test/world/discovery-grouping.test.ts
ktest bun test packages/mcp/test/world-grouping.test.ts --timeout 120000
bun test packages/core/test/contracts/world-card-kit.test.ts packages/core/test/contracts/concept-card.test.ts packages/core/test/contracts/situation-card.test.ts
bun test packages/core/test/serving/world-projection.test.ts packages/core/test/serving/world-coverage.test.ts packages/core/test/serving/world-occurrence-correction.test.ts
```

The golden files in `packages/core/test/world/golden` are the traces of a client's `world_view` calls for the owner, a narrow agent, a revoked source, a purged event, a partial-coverage reader and the paging and overflow cases. Wire tokens are random, so a token is named by its first appearance; every other byte and the key order are compared as served. `KIZUKI_UPDATE_GOLDEN=1` rewrites them and belongs only in a change that means to move a byte.

`withWorldPipeline` and `collectReadFrames` are test seams, exported only through `@kizuki/core/testing`. They swap process-wide lists, do not nest and no production code calls them.

The F1B entries for the foundation and first-Concept packets in [packet-seams.json](packet-seams.json) map these existing public operations to seam files and executable acceptance tests. `bun scripts/verify-packet-seams.ts` checks the table, files and Core/CLI/MCP registration parity; the existing operation tests exercise the shared HTTP and App dispatch. These entries describe F1B's implemented scope, not completion of the entire packets.

## Limits

- Collectors and groupers have the smallest shape that lets identity work plug in. Identity convergence may reshape them.
- `rowsExamined` counts collect-stage rows only. Statement counts through the database connection remain the harness's other work counter.
- The packet verifier is a standalone scaffold; integration into the continuous world verification gate remains separate.
