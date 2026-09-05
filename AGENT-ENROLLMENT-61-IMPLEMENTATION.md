# Agent enrollment #61 implementation

Implementation commit: `f1e3dd61f5ebd443ce277fb83cccb43879e7ebf9`.

Worktree: `/home/ubuntu/LifeOS/workspace/kizuki-agent-enrollment-20260905`.
Base: `55a206a7a45f0ba986ebc31cc5f3c586db0de50f`.

## Result

`DEFAULT_GRANT` now authenticates arbitrary agents with public, empty
tool/type/subject scopes, rate 60, and no correction relay. The built-in
`OWNER` remains unchanged. `OWNER_AGENT_GRANT` is a literal explicit preset
with the former useful private harness authority. Stored grants are untouched.

The RFC and decision log record #61 as the supersession of the old personal
default. Core and MCP fixtures now pass explicit grants when their scenario
requires authority.

## Verification

All credited commands used
`/home/ubuntu/.npm/_npx/b0e2f39cb236944d/node_modules/.bin/bun` at version
`1.3.10`.

```text
bun test packages/core/test/agents/identity.test.ts packages/core/test/agents/authorization.test.ts packages/core/test/agents/audit.test.ts packages/core/test/sensitivity/resolution.test.ts packages/mcp/test/principal.test.ts packages/mcp/test/server.test.ts
123 pass, 0 fail, 348 assertions

bun run typecheck
pass

git diff --check
pass
```

The fresh worktree initially had no installed dependencies; pinned
`bun install --frozen-lockfile` completed before verification. No product test
failure remained after fixtures were made explicit about the authority they
require.
