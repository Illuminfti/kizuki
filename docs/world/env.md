# Serving envelopes and context packets

Implemented: Core dispatch accepts a separate `response_contract` option with
`kizuki.envelope/v1` or `kizuki.envelope/v2`. The selector carries no authority;
every call still rechecks identity, grants, sensitivity and source consent.
Unknown, nested and conflicting selectors return `unsupported_contract` before
candidate discovery, with an audit row. `world_view` retains its existing v2
contract. `system_health` has no v2 form and returns the fixed contract refusal.

A v2 envelope has exactly `schema`, `tool`, `principal`, `at`, `canon`, `quoted`
and `data`. It carries no denied counts or source-policy counter. Principal
references are scoped opaque references. Chunk identifiers and write-result
identifiers retain their existing forms in this stage; the typed-reference
migration is separate work.

Selecting envelope v2 also selects `kizuki.context-packet/v2`. Its Markdown
starts with `KIZUKI CONTEXT v2`, preserves the canon/capture separation and has
no epoch or digest header. The result is `current`, `unchanged` or `incomplete`.
The optional `priorView` is a hash-only content baseline, checked against a
freshly assembled authorized packet, including its metadata and chunks.
`unchanged` carries no packet content. Degraded reads return `incomplete` with
the coverage gap. This baseline is not a stored world-view token or a history
capability. The legacy arguments `capabilities`, `retain_prefix`, `prior_hash`
and `epoch` are rejected under v2. Ingress and session import recognize both
packet markers as machine output.

## Adapters

Token-authenticated stdio MCP sessions select v2 internally and advertise v2
output schemas. Owner sessions retain their existing v1 behavior, except
`world_view`, which already uses v2. The MCP tool surface remains ten tools;
`propose` and `correct` are its only write tools.

The loopback tool endpoint accepts this closed wrapper on its existing routes:

```json
{"response_contract":"kizuki.envelope/v2","args":{"budget_tokens":1000}}
```

Send that body to `/v1/context_packet` with the caller's bearer. Token clients
that omit the selector also receive v2; the adapter supplies it. Owner requests
keep the legacy default. The transport route version does not select the
content version. Nested selectors are refused, including a selector inside
`args`. Explicit v1 HTTP requests and
direct Core calls with missing or v1 selectors still retain compatibility in
this stage. Refusing those scoped requests is a separate draft change pending
the compatibility decision.

The owner CLI supports explicit selection:

```sh
kizuki context --response-contract kizuki.envelope/v2 --budget 1000 --json
kizuki query ordinary --response-contract kizuki.envelope/v2 --degraded --json
kizuki tell "Use the current definition." --claim CLAIM_ID --dry-run --response-contract kizuki.envelope/v2 --json
```

V2 JSON is `{schema:"kizuki.cli-result/v2", command, result}`, with `command`
equal to `query`, `context` or `tell`, and the selected Core envelope as `result`.
Text renders that same response. The default and explicit v1 retain each
command's previous output. V2 `tell` requires a target accepted by the shared
serving correction operation; its legacy `--since` and `--until` scope flags
are unavailable under v2. Correction diffs still use the existing result codec
in this stage.

The session-start hook requests v2 for both daemon and direct reads. An
unsupported daemon yields no stdout; `--verbose` reports
`hook: nothing injected (unsupported_contract)` on stderr. It does not inject
a legacy packet after a v2 refusal. No model is required for these reads.

## Executable seams

| Seam | Regression tests |
| --- | --- |
| Core dispatch and packet round trip | `packages/core/test/serving/context-packet-v2.test.ts` |
| Loopback selector table and hidden-source epoch regression | `packages/core/test/serving/envelope-v2.test.ts` |
| Ten-tool bytes, errors and work-counter matrix | `packages/core/test/serving/v2-noninterference.test.ts` |
| Real stdio and new-client context/world reads | `packages/mcp/test/envelope-v2.test.ts` |
| CLI JSON and text selection | `packages/cli/test/response-contract.test.ts`, `packages/cli/test/tell.test.ts` |
| Hook default and unsupported-contract skip | `packages/cli/test/hook.test.ts` |
| Session-import marker filtering | `packages/connector-agent-sessions/test/hostile.test.ts` |

No ledger migration is needed. Existing owner compatibility tests remain the
v1 contract guard. Typed chunk references, stored view-token lifecycle and
world history are separate capabilities and are not claimed here.

The ten-tool noninterference matrix checks response bytes, refusal errors and
SQL work counters across hidden source revocation, correction, supersession,
identity changes and purge. A separate regression covers the first hidden
source on a previously unmanaged ledger. Loopback and real stdio tests check
the serialized contract, and redaction tests prove that secret-shaped text is
still replaced inside the seven-field envelope. These tests reuse the shared
reader policy rather than introducing another authorization implementation.

The work-counter acceptance gate remains open: the current matrix detects
hidden-state-dependent SQL work in timeline audit collection, denied proposal
provenance and correction targets, and session identity candidate selection.
Response bytes and refusal messages remain stable in that matrix. These
shared reader repairs must be coordinated before this change is ready to merge.
