# Legacy identity containment limits

Legacy `identity_links` rows are retained for backup compatibility but are not
identity authority. Kizuki cannot infer aliases, merges, corrections, or purge
scope from them.

The service continues to return ordinary capture, claims, search, timeline,
context, and undo behavior. Context packets and doctor identify the unavailable
identity capability with `identity-authority-unavailable`.

An owner who needs identity effects must wait for a separately reviewed,
receipted migration and authority design. Re-entering old rows through import
or restore does not make them active.

## Purge verification

Raw-subject purge remains available. It snapshots selected subjects before
removing events and deletes legacy rows incident to erased endpoints or support.
Malformed selected subjects, oversized legacy state, and unresolved retained
support fail closed. Alias-expanded purge is unsupported.

A0 retains no erased subject dictionary or endpoint digest. After restart it
can therefore prove identity absence only when `identity_links` is empty.
`purge --verify` reports `ok: false` while any legacy row remains, including
unrelated inert history. Source revocation also remains incomplete when identity
absence cannot be proved. No automatic action deletes unrelated rows to make
that check pass.

## Backup compatibility

Backup v3 requires the identity stream and stores evidence in a closed tagged
raw-text encoding. Restore preserves that opaque text exactly; it does not
interpret the rows as aliases. V1/V2 keep their original JSON-value import
semantics. Older readers reject v3 rather than silently reinterpreting it.

The shared storage scanner admits at most 10,000 rows, 1 MiB of aggregate field
text, 8,192 parsed references, and 16 KiB of evidence per row. Export and restore
apply the same limits; restore additionally caps each JSONL row and the complete
stream before publishing the target. Oversized legacy state requires a separately
reviewed migration, never silent truncation.

Known erased endpoint hashes in a legacy source-erasure report block both new
exports and restore publication with
`legacy_identity_erasure_reconciliation_required`. Resume source erasure on the
original vault before exporting. All supported archive versions refuse a
present nonempty or malformed hash field. V1/V2 alone may normalize a missing
compatibility field to an empty array; current v3 requires that explicit empty
field. Source-erasure reports are limited to 2,000,000 UTF-8 bytes, checked
before decoding or parsing, and their JSONL transport has a corresponding
bounded row size. Invalid UTF-8 JSONL is rejected before JSON parsing.

## Verification

Use the repository-pinned Bun version to run the public containment, purge,
source, serving and backup regressions:

```bash
bun test packages/core/test/claims/identity.test.ts packages/core/test/purge/totality.test.ts packages/core/test/source-grants.test.ts packages/core/test/export.test.ts packages/core/test/serving/packet-claim-boundaries.test.ts packages/core/test/serve/doctor.test.ts
bun run typecheck
```
