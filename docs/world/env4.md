# Scoped contract refusal: compatibility decision pending

Draft implementation, separate from the envelope and packet v2 rollout.
Do not merge or release this change before the scoped compatibility decision
is granted.

Core dispatch requires an explicit `kizuki.envelope/v2` selector for scoped
principals. A missing selector, explicit v1 selector or unsupported selector
returns the same `unsupported_contract` refusal before argument validation or
candidate discovery. Refusals recheck identity and rate limits and leave an
audit row. The selector confers no authority.

Owner calls retain missing-selector and explicit v1 compatibility. Owner
`world_view` retains its existing v2 default. Token MCP, loopback HTTP defaults
and the session-start hook already send v2; their behavior does not depend on this compatibility
change. `system_health` still has no v2 form.

The acceptance test is `packages/core/test/serving/scoped-v1-refusal.test.ts`:
all ten tools with both legacy forms at Core dispatch and explicit v1 over
loopback, no candidate queries, fixed errors and audit receipts, plus owner
compatibility. HTTP supplies v2 for a token client that omits the selector.
This guard applies at Core dispatch, the shared host
seam; internal legacy serving helpers retain their existing contracts.

No migration is required. This draft depends on the envelope and packet v2
implementation. D-ENV remains ungranted; this PR must stay draft and unmerged.
