# Core retrieval ceiling implementation review

Evidence date: 2026-09-05. Status: implementation committed and clean; local
verification passed. Independent review and the composed full repository gate
remain open. No issue closure, merge, release or agent-identity closure is
claimed by this receipt.

## Immutable scope

| Item | Value |
| --- | --- |
| Issues | [57 / KZ-185](https://github.com/Illuminfti/kizuki/issues/57), [58 / KZ-186](https://github.com/Illuminfti/kizuki/issues/58) |
| Worktree | `WORKTREES/kizuki-retrieval-ceilings-20260905` |
| Branch | `agent/kizuki-retrieval-ceilings-20260905` |
| Commit | `753c96f5eb6a3a56f4daef3b5ee99814e6312963` |
| Source tree | `5069f53f0a639ed2eee091c1c31a05b55ac80dbc` |
| Parent | `dc961380dafc055f74df14a4c5afc0330792cc32` |
| Parent composition | Recovery `2f5e37998c5b14eb2e94566a8913a396ed17ce5f` plus main `178415cccf312b98c966902826906cea829074c1` |
| Commit scope | 15 files, 419 insertions, 144 deletions |

Before commit, the owned implementation paths were compared against fetched
main `861374cf4c6d476b92ba31a0a087e27a1add5132`; those paths had no incoming
changes. Source has remained frozen since the verification run began. Root
owns subsequent composition and final full CI.

The [accepted design](P0-57-58-RETRIEVAL-CEILING-DESIGN.md) preserves the original
72-observation reproduction against both the audit snapshot
`870ccdca1c487d5dbebdabfa08b961d8a6a4c824` and the named pre-repair current
public exports. It also records the compatibility and authority boundaries.

## Resulting behavior

Public `search`, `searchResult` and `timeline` require an options argument with
a primitive `public`, `personal` or `private` ceiling. They capture and validate
that label once before every early return or database read, then always include
the ceiling predicate in SQL. Missing options, malformed labels, boxed strings,
arrays and coercible objects throw the fixed `RangeError` instead of falling
through or relying on driver behavior. Null, unknown and unlabeled stored
labels remain outside every valid ceiling.

Serving still derives its explicit ceiling from the authenticated grant. Its
second pass now projects only audit candidate identities: search returns
`doc_id` and `scope`, and timeline returns event IDs. Shared internal SQL plans
preserve the existing filters, ordering, limits and search degradation state.
Current event policy metadata comes from the existing `readServableEvents`
helper, so audit classification no longer loads hidden snippets or previews.
The new helpers are absent from all public barrels and package exports.

`validateRetrievalQuery` now uses the existing own-key `isSensitivity` guard for
the query ceiling. Other retrieval result/document validation and agent-grant
validation remain with their existing owners.

## Compatibility and ownership

This deliberately tightens the legacy raw query APIs. TypeScript callers that
omit the ceiling stop compiling; JavaScript callers receive a fixed validation
error. Existing legitimate internal and test callers now state their intended
ceiling. The `kizuki.retrieval/v1` port already required a ceiling, so its shape
and version do not change. The public API note is committed as
`docs/query-ceilings.md` and linked from architecture documentation.

A ceiling is a storage filter, not an authenticated grant. A caller holding a
trusted database capability can already issue arbitrary SQL. This repair does
not claim to resolve issue 61 or change principal authentication, event/schema
contracts, migrations, root exports, provider implementations or connector
credentials. The three edits in `core/test/migration.test.ts` only add explicit
query options; the event migration owner was informed.

The simplification review consolidated filter/order/limit construction into one
private plan per query and removed the duplicated text-returning audit pass.
It adds no public unrestricted-query option or public uncapped query helper.

## Verification

Commands ran from the absolute worktree above with Bun 1.3.10. The all-core and
final helper checks began on a frozen working tree before commit. Their source
is exactly tree `5069f53f0a639ed2eee091c1c31a05b55ac80dbc`, now committed as
`753c96f`; they are labeled frozen-source receipts, not commands launched on
that already-existing Git HEAD. The full composed exact-HEAD gate is still
required.

| Check | Result | Receipt |
| --- | --- | --- |
| Direct public API regression before implementation | 1 pass, 10 fail; expected red | `TEMP/kizuki-ceilings-public-red.log` |
| Initial public/serving focus | 34 pass, 0 fail, 178 assertions, 3 files | `TEMP/kizuki-ceilings-focused.log` |
| Query/search/serving/rebuild/migration regression | 275 pass, 0 fail, 1,115 assertions, 22 files, 129.02 s | `TEMP/kizuki-ceilings-regression.log` |
| All core on final frozen source | 1,584 pass, 0 fail, 24,551 assertions, 129 files, 221.88 s | `TEMP/kizuki-ceilings-core.log` |
| Final typecheck | PASS, exit 0 | `TEMP/kizuki-ceilings-final-types.log` |
| Network source verification | PASS, 21 allowlisted files on this pre-X base | `TEMP/kizuki-ceilings-network.log` |
| Verification policy tests | PASS, exit 0 | `TEMP/kizuki-ceilings-policy.log` |
| Secret verification | PASS, exit 0 | `TEMP/kizuki-ceilings-secrets.log` |
| Staged diff check and committed worktree status | PASS; worktree clean | Captured before and after commit |

The 275-test regression preceded the final getter-mutation assertions; those
assertions are included in the complete 1,584-test core receipt. No production
source changed between those runs.

```bash
cd WORKTREES/kizuki-retrieval-ceilings-20260905
npx -y bun@1.3.10 test packages/core/test
npx -y bun@1.3.10 run typecheck
npx -y bun@1.3.10 run verify:network
npx -y -p bun@1.3.10 -c 'bash scripts/verify-policy.test.sh'
npx -y bun@1.3.10 run ci:secrets
git -C WORKTREES/kizuki-retrieval-ceilings-20260905 diff --check
git -C WORKTREES/kizuki-retrieval-ceilings-20260905 status --short
```

The new public-export regressions verify missing/null/malformed options before
any SQL, including empty query and zero limit, and capture a changing ceiling
getter only once. Real in-memory ledger/index fixtures cover all three valid
ceilings and six stored-label cases. Audit projection tests verify the actual
selected columns, public export absence, original filtering/order/limits and
zero-limit behavior. Existing serving suites continue to verify denial counts,
ID/title redaction, current-label rechecks, consent, tombstones, degradation and
context-packet behavior. Two previously pending unlabeled/private assertions
are now executable regressions.

Navigation was refreshed at 2026-09-05T17:16:01+01:00. `vps-nav health` confirms
index checksums pass and returns review/exit 1 for the same 12 estate root-drift
entries observed immediately before refresh. No root reorganization was made;
these estate inventory findings are separate from the passing source checks.

## Remaining gates

1. Independent immutable-head review for correctness and trust boundaries.
2. Compose current main and other accepted changes through root's owned lane.
3. Pass the required full repository gate on that exact reviewed composition,
   then apply the repository's separate merge and issue-closure procedure.
