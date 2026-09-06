# P103 worker handoff: one sensitivity lattice

Base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Own exactly `packages/connectors/src/sensitivity.ts` and `packages/connectors/test/sensitivity.test.ts`.

## Defect and required behavior

RFC 0002 and `packages/core/src/sensitivity/resolve.ts` define sensitivity as the maximum of connector floor, connector default or upward refinement, and owner label. The connector package currently duplicates the lattice and returns the maximum of only floor and event hint when a hint exists. A hint can therefore lower a stricter connector default. Existing tests encode that divergence. Current importer calls omit hints, so this packet makes no historical exposure claim.

Keep the connector helper's public signature for its callers, but implement it as a thin adapter to the exported core resolver using connector default, connector floor and event hint. Remove the second order table/comparison algorithm. Valid hints may raise the default and may never lower it. Unknown or absent values fail closed to private through core behavior. Do not change importer manifests, emitted fixture labels, core policy or conformance ownership.

Replace the downward expectation with neutral parity coverage across public, personal and private default/floor/hint values plus absent and unknown inputs. Compare the adapter's answer with the core resolver. Keep importer manifest and fixture tests unchanged. This is defensive contract validation; do not create or describe data-exposure reproductions.

## Validation and boundaries

Run `bun test packages/connectors/test/sensitivity.test.ts` with Bun 1.3.14 and applicable non-live connector checks. Record final SHA/tree and exact results in `/work/out/result.json`. If parity requires changing a caller, core or manifest, stop and report the failing case; the packet does not authorize wider edits.
