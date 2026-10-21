# World diffs

`world_view` operation `diff` compares one retained object view with its fresh
authorized projection. It uses the existing view-token store, permission checks,
and card readers. It does not call a model or write canon.

Read the object first and retain its issued `view`. Then send the same object,
valid-time window and recorded-time query:

```json
{
  "operation": "diff",
  "of": { "operation": "concept", "concept": { "kind": "object", "token": "OBJECT_TOKEN" } },
  "priorView": { "kind": "view", "token": "VIEW_TOKEN" },
  "valid": { "kind": "all" },
  "knownAt": { "kind": "current" }
}
```

The CLI form is `kizuki world --operation diff --of-operation concept
--ref=OBJECT_TOKEN --prior-view=VIEW_TOKEN --json`. Inline option values also
handle opaque tokens beginning with `--`. The MCP `world_view` tool, loopback
HTTP and App use the same Core operation. A complete App detail offers **Check
for changes**, followed by **Read current item** or **Check for more changes**.

An unchanged projection returns `unchanged` without extending the token's
15-minute lifetime. A changed projection returns `kizuki.world-diff/v1` with
added, removed and changed claim references, at most 128 in each group. An owner
correction removes the old claim and adds its replacement. Qualifier changes
name perspective, valid time, context, assessments or conflict. A change in
other card content can legitimately return empty claim groups; the full view
comparison still detects it.

The replacement token retains the fresh object projection, so it works for
the next diff and for a conditional read of that object. An incomplete fresh
read returns that card and its gaps. A comparison exceeding a group bound
returns an incomplete diff with `traversal_limit` and no new token.

Unknown, expired, erased, restored, differently scoped, or unauthorized
baselines uniformly require a new view. No old identifiers or explanation
are returned. Publication rechecks the baseline as well as fresh evidence.
Without a reserved view partition, a caller must make a fresh ordinary read.

## Verification

Run the synthetic public-seam checks from the checkout:

```bash
bun test packages/core/test/world/diff.test.ts
bun test packages/core/test/world/verification-matrix.test.ts
bun test packages/cli/test/world-verification-parity.test.ts
bun test packages/cli/test/app-client.test.ts
bun run typecheck
```

These exercise correction, conditional reuse, restore, purge, revocation,
missing history, publication races, capacity, bounded comparison, hidden-source
noninterference, actual transports and the shipped App client. The wider
longitudinal fixture remains a separate integrated acceptance requirement;
these tests do not claim to execute its future outcome and forecast scenarios.
