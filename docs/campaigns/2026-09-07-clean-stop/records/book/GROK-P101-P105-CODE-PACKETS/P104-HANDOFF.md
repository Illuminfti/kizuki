# P104 worker handoff: MCP source-policy output schema

Base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Own exactly `packages/mcp/src/schemas.ts` and `packages/mcp/test/schema.test.ts`.

## Defect and required behavior

Every MCP tool advertises `ENVELOPE_SHAPE` as its output schema and returns the core envelope as `structuredContent`. Core's envelope type and serving gate include optional `source_policy`; the gate emits `{mode:"enforced", epoch, legacy_unbound:"owner_only"}` once the source-policy epoch is nonzero. The advertised schema omits that field. A client that calls `tools/list` builds an output validator and can reject the policy-enforced response.

Add one exact optional source-policy schema to the shared envelope: literal mode `enforced`, positive integer epoch, and literal legacy value `owner_only`. Do not change core, server registration, tool results, error envelopes or authorization.

Extend `schema.test.ts` through the real listed-client seam. Establish an ordinary source-policy epoch with existing public test helpers, call a tool after `listTools`, and assert the validating client succeeds and both text and structured envelopes contain the exact policy object. Keep an epoch-zero omission case. Add direct or advertised-schema assertions that malformed, missing-required, extra and mistyped policy members fail without loosening other envelope keys.

## Validation and boundaries

Run `bun test packages/mcp/test/schema.test.ts` with Bun 1.3.14 and applicable package checks. Record final SHA/tree and exact results in `/work/out/result.json`.

Do not edit `server.ts`, core serving/source-grant files, other MCP tests, P004/P006/P015/P057/Astra files, credentials, protocol transport, or release state. This proves schema fidelity only.
