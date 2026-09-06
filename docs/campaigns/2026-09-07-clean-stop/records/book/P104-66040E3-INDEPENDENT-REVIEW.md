# P104 schema review and sealed failure triage

The source-policy schema change is correct. The candidate remains unaccepted until the inherited positive-canon fixture is corrected and the qualified test is rerun. Sealed run `ff8c50283a8a48bba1c9ed29ad0e70c0` remains **6 pass, 1 fail, 67 assertions**, exit 1, on Bun 1.3.14. All four added source-policy tests passed. This review executed no product code or tests.

Reviewed candidate `66040e3df3ee452c459ac1e45360efe731158715`, tree `4b33eca55ab3e6df5344595cf23fa7c37873e0e5`, with sole parent `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. Exactly `packages/mcp/src/schemas.ts` and `packages/mcp/test/schema.test.ts` changed. Diff whitespace check passed. The sealed owned files match the committed candidate and the receipt's input hashes. Both retained log hashes were verified.

## Failure cause

The failing existing test requires `get_page(person:ada)` to return a canon chunk, then compares every emitted key with the advertised required keys. Its entire test body is unchanged from f57; only import additions shifted the failing assertion to line 82.

`packages/mcp/test/helpers.ts:66–79` writes Ada directly with `writeFileSync`/`serializePage`. The page has no `sources`. The helper later accepts a separate event at lines 107–122, but neither links that event to the page nor records a canon write receipt.

Existing f57 admission explains the empty result:

- `vault/schema.ts:118–126` requires nonempty sources on an active page.
- `vault/provenance.ts:20–33` requires those sources to resolve to live external events and a revision recorded against the page's current hash.
- `canon/authority.ts:70–88` gives an unrecorded file no positive revision basis.
- `serving/canon.ts:140–142` withholds a page without that evidence, including for the owner.
- `serving/page.ts:49–55` returns an empty canon array with a held denial for that decision.

All those files, the MCP helper and the server were verified byte-identical across f57, the candidate and sealed source. Static evidence therefore identifies an ordinary stale fixture, not a P104 product regression. No base execution is claimed. Merely adding `sources` to the raw page would still leave the required recorded revision absent.

## Minimal scoped correction

Change only `packages/mcp/test/schema.test.ts`. In the existing trust-field test, create one separate positive canon fixture with `recordedPage` from `../../core/test/helpers/recorded-page`, using the existing `running.db` and `running.vaultPath`. Give it a new path such as `entities/schema-canon.md`, a matching stable ID such as `person:schema-canon`, ordinary neutral prose, and complete active-page fields: title, type, sensitivity, taint and subjects. Then request that ID in the existing `get_page` call.

That existing helper captures ordinary synthetic evidence, files a claim, resolves its target and calls the actual receipted writer (`core/test/helpers/recorded-page.ts:44–64`, `core/test/canon/helpers.ts:76–86`). It creates both real ledger provenance and the recorded page revision. A separate page avoids overwriting the fixture's unrecorded owner file. It requires no shared MCP helper, Core or server edit. The direct page read does not require a derived-index rebuild.

Keep `expect(chunk).toBeDefined()`, the advertised `taint` and `authority` requirements, and exact equality between emitted keys and advertised required keys. Also assert the returned page ID and sources against the helper result; comparing authority with its receipt preserves concrete trust evidence. Do not skip the test, accept an empty chunk, make trust fields optional, fabricate a database receipt, or relax serving admission. Preserve the complete source-policy matrix and the sealed failure receipt.

Root should run the exact assigned file through the qualified runner after the correction. A new successful receipt is required; this diagnosis supplies no passing result.

## Schema review

`SOURCE_POLICY` is a closed strict object with the exact literal mode `enforced`, positive integer epoch, and literal `legacy_unbound: owner_only`; its envelope field is optional. It matches `serving/types.ts:69` and `serving/gate.ts:328`, which omits the field at epoch zero. Existing canon, quoted, denial and envelope fields are unchanged. The shared registration in `mcp/src/server.ts` advertises this envelope for every tool; text and structured outputs still carry the same Core envelope.

The new tests list tools before calling the validating client, establish an ordinary positive policy epoch, compare both response channels, retain epoch-zero omission, inspect all tools' required fields, and reject missing, extra, mistyped and invalid nested members. No schema correction was found. The remaining work is the fixture correction and qualified rerun, not weakening the schema or the Core trust boundary.

Machine-readable evidence: `P104-66040E3-INDEPENDENT-REVIEW.json`.
