# World operation registry

Status: implemented on the expansion branch. This note describes the seam that lets a new `world_view` operation arrive as new files plus one line per surface. It adds no migration, no MCP tool and no grant.

## What it does

`world_view` is one tool over a registry of operations. The reader in `serving/world-view.ts` authenticates the caller, checks the `world_view` grant, finds the operation named by `operation`, checks its exact keys and dispatches. It never names an operation itself.

Four operations keep their exact output: `find_concepts`, `find_situations`, `concept` and `situation`. One is new: `describe`.

| Operation | Source | Keys beyond `operation` | Result schema |
| --- | --- | --- | --- |
| `find_concepts` | claims | `label`, optional `cursor`, `valid`, `knownAt` | `kizuki.concept-matches/v1` |
| `find_situations` | claims | `label`, optional `cursor`, `valid`, `knownAt` | `kizuki.situation-matches/v1` |
| `concept` | claims | `concept`, `valid`, `knownAt` | `kizuki.concept-card/v1` |
| `situation` | claims | `situation`, `valid`, `knownAt` | `kizuki.situation-card/v1` |
| `describe` | build | none | `kizuki.world-describe/v1` |

A `claims` operation reads claims. The reader parses `valid` and `knownAt`, answers `unavailable` with reason `history` for any time cutoff it cannot serve, answers `unavailable` with reason `storage` when the world tables are missing, and runs the operation inside the one immediate transaction with the caller's authorization namespace. A `build` operation reads nothing: it takes only `operation`, opens no transaction and cannot vary with vault contents.

A result larger than 256 KiB is never served in part. It becomes `unavailable` with reason `budget`.

## Describe

`world_view {operation: "describe"}` returns `kizuki.world-describe/v1`: the kinds this build can serve with a `shipped` or `dark` state and a population path, the registered operations with their keys and result schemas, and the vocabulary version. It carries no counts and no claim data, and it is byte-identical for every principal that holds the `world_view` grant. It lists only registered kinds and operations.

A kind is `dark` when its population path is `extraction_off` or `none`. Today `concept` and `situation` are `shipped` through typed extraction. The state depends on the build, never on what a vault holds, so an empty `shipped` kind means "nothing admitted yet", not "cannot exist".

## Add an operation

An operation is one file per surface and one line in each registry.

1. Core. Add `world/ops/<name>.ts` exporting a `ClaimsOp` (or a `BuildOp`) with its name, its own keys, its data schema ids, a closed `parse` and a `run`. Add one line under your marker in `WORLD_OPS` in `world/ops/registry.ts`. `worldOpRegistry` refuses an operation without a name, a schema id, a `parse` or a `run`, a duplicate name, or a key that shadows `operation`, `valid` or `knownAt`.
2. MCP. Add `mcp/src/world/ops/<name>.ts` exporting a fragment: the optional input fields it adds, the closed body grammar of each result schema id, and one sentence for the generated description. Add one line under your marker in `MCP_WORLD_OPS`. The flat input, the answer grammar, the listed output and the tool description are generated.
3. CLI. Add `cli/src/commands/world/ops/<name>.ts` exporting a spec: usage text, options, bounds, `buildInput` and `render`. Add one line under your marker in `WORLD_CLI_OPS`, or an entry with `cli: null` and a reason. Usage and bounds are generated.

The App host and loopback HTTP need nothing: the App route accepts any key a registered operation accepts, and HTTP dispatches to the same reader.

`@kizuki/core/world` is the public entry for operation authors. `packages/core/src/index.ts` and its export-list test are not edited for new operations.

## Tests

```bash
bun test packages/core/test/serving/world-ops.test.ts
bun test packages/mcp/test/world-ops.test.ts
bun test packages/cli/test/world-ops.test.ts
```

The core test proves the registry invariants, a test-only operation routed through the reader, and `describe`. The MCP test proves the generated schema and that a test-only fragment is advertised and answered. The CLI test proves that every registered operation has a fragment, a spec (or a stated reason) and App route keys, and routes a test-only operation through `kizuki world`, loopback HTTP and the App host. The test-only operation registers through `withWorldOps` from `@kizuki/core/testing`, which no production code uses.

## Limits

- The result type is a closed union of the shipped bodies. A later operation adds its body type to `WorldData` when it lands.
- The kind list behind `describe` is a small table in `world/ops/kinds.ts`. It is not yet the vocabulary registry, which arrives with the write-time vocabulary work.
- `describe` takes no `valid` or `knownAt`. It is derived from the build.
