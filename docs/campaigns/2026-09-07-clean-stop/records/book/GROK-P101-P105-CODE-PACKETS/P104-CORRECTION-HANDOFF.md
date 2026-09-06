# P104 corrective handoff: a recorded positive canon fixture

Root-authorized correction on 2026-09-06. Integration base remains `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Start from existing candidate `66040e3df3ee452c459ac1e45360efe731158715`. Preserve its history and add a normal corrective commit; no amend, reset, rebase or replacement commit.

The original ownership remains exactly `packages/mcp/src/schemas.ts` and `packages/mcp/test/schema.test.ts`. The independent review accepts the source-policy schema change. This correction should affect only `schema.test.ts`; preserve the strict optional SOURCE_POLICY object and every existing envelope field and source-policy assertion.

## Accepted diagnosis

Sealed run `ff8c50283a8a48bba1c9ed29ad0e70c0` at the start head returned 6 pass, 1 fail and 67 assertions on Bun 1.3.14. All four new source-policy tests passed. The failing existing trust-field test at line 82 expects a canon chunk from `person:ada` but receives none. This remains a failing result, not a pass qualified by review.

The shared MCP helper writes Ada directly with writeFileSync/serializePage and no sources or recorded revision. The later accepted event is not linked to that file. Existing f57 Core admission requires nonempty live external source evidence and a recorded revision bound to current page bytes. It correctly withholds this raw file, including from the owner. The entire failing test body and the relevant helper, provenance, authority and serving sources are unchanged from f57 and match the sealed source. Static review identifies an inherited positive-fixture defect; no base execution or new reproduction is claimed.

## Minimal correction

Inside the existing canon trust-field test, create one separate ordinary positive page through the existing `recordedPage` helper at `../../core/test/helpers/recorded-page`. Use the current fixture's database and vault, a new path such as `entities/schema-canon.md`, a matching new ID such as `person:schema-canon`, complete active-page fields (title, type, sensitivity, taint and subjects), and short neutral prose. Then request that page ID through the listed MCP client.

This existing helper captures ordinary synthetic evidence, inserts a claim, resolves its target and uses the actual receipted writer. Its returned sourceIds, claim and receipt provide concrete expected evidence. Read-only inspection of this helper, its Core test-writer helper and the provenance/admission functions named here is allowed; they remain outside write ownership. Do not copy or change those helpers. A separate page avoids overwriting the unrecorded owner fixture. A direct get_page read does not require a derived-index rebuild.

Retain the existing chunk-present assertion, the advertised required taint and authority checks, and exact equality between emitted keys and advertised required keys. Assert the concrete returned page ID, source IDs and authority against the ordinary fixture/writer result. Preserve listing before the validating call, text/structured source-policy equality, epoch-zero omission, positive integer epoch and exact literal requirements, and all malformed-member assertions.

Do not skip, delete or weaken the failing test; accept an empty canon response; make taint/authority optional; add sources to a raw page without a real revision; insert fabricated receipt rows; or relax Core serving. No shared MCP helper, server, Core, other test, schema contract or authorization changes are required. No vulnerability, data-exposure, fault/race or resource reproduction is authorized.

## Validation and delivery

Root owns sealed test execution. Do not run Bun tests, product commands, builds or ad hoc reproductions in the worker container. Write `/work/out/test-request.json` with a new request id such as `p104-correction-recorded-canon-fixture` and exactly `test_paths: ["packages/mcp/test/schema.test.ts"]`. If no root result is supplied, finish with `awaiting_root_test`; do not claim a pass or poll indefinitely.

Add a normal corrective commit retaining the supplied start head as an ancestor. Report base_sha, start_head, final head_sha/tree, exact paths, test request and any supplied root receipt in `/work/out/result.json`. Preserve the original sealed failure. No account, model, native, service, remote, controller, roster or release action is authorized. Root must obtain a new passing sealed receipt and independently review the corrected candidate before acceptance.
