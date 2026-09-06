# Core search and timeline sensitivity ceilings

Evidence date: 2026-09-05. Status: root accepted this design and the bounded
implementation is committed at `753c96f5eb6a3a56f4daef3b5ee99814e6312963`, tree
`5069f53f0a639ed2eee091c1c31a05b55ac80dbc`. The frozen source passed 1,584 core
tests and type, network, policy and secret checks. Independent review and the
composed full repository gate remain open. See the exact
[implementation receipt](P0-57-58-RETRIEVAL-CEILING-REVIEW.md).

The sections below retain the original pre-repair evidence and accepted design.
References to current source in those sections mean the explicitly named
reproduction snapshot, before this repair.

## Recommendation

Require an explicit, runtime-validated sensitivity ceiling on the public
`search`, `searchResult`, and `timeline` functions. Always include the ceiling
predicate in SQL. Reject an absent or malformed ceiling before reading the
index or ledger, including empty-query and zero-limit shortcuts. Keep the
existing bounded audit-denial behavior through internal queries that return
only candidate identities or policy metadata, never snippets or previews.

This closes the observed public API defect while retaining current serving and
audit semantics. A default of `private` still exposes private records to a
caller that supplied no ceiling. A default of `public` is safer but hides a
missing-policy programming error and does not fulfill the issues' explicit
mandatory-ceiling requirement. A public unrestricted-query flag or helper
would reproduce the bypass under another name.

## Issues and original reproduction snapshot

Both [issue 57](https://github.com/Illuminfti/kizuki/issues/57) and
[issue 58](https://github.com/Illuminfti/kizuki/issues/58) were OPEN when read. Their
bodies were read live. They name findings KZ-185 and KZ-186 and require the
original audit reproduction to remain pinned to
`870ccdca1c487d5dbebdabfa08b961d8a6a4c824`, followed by confirmation on current
main. Their last visible updates are 2026-09-02 at 15:18:36Z and 15:18:39Z.

Both conditions are met here. An isolated temporary `git archive` of the
original core source supplied its exact public `src/index.ts` export. The
current public export was loaded from `dd41d64f...`, which contains current
main `34179224ce388b6faa319de4b03cb77dc1dc664e`. Direct Git comparison shows no
difference from that main revision in the search/query, agent-policy,
retrieval-contract or relevant retrieval/serving implementation paths.
No historical or current checkout was edited for the reproduction.

The original snapshot exports `search` and `timeline`; `searchResult` was added
later. Current main still exports all three from `@kizuki/core`:
`packages/core/src/index.ts:676` and `packages/core/src/index.ts:703`.
These are supported package exports, not only deep internal imports.

## Reproduction receipts

The primary probe is `TEMP/kizuki-retrieval-ceiling-native-probe.ts`, run with:

```bash
cd WORKTREES/kizuki-x-api-resume-20260905
npx -y bun@1.3.10 TEMP/kizuki-retrieval-ceiling-native-probe.ts
```

It imports the exact original and current public exports, uses each revision's
real `openLedger(':memory:')`, `initSearch`, and `accept`, then invokes the
public query functions directly. Valid source events enter through `accept`;
only the synthetic in-memory fixtures are adjusted to represent null, unknown
and unlabeled stored labels. FTS rows use each revision's actual index schema.
There is no real vault, credential, agent token, or provider request.

The command exited 0 and produced 72 structured observations in
`TEMP/kizuki-retrieval-ceiling-native-probe.jsonl`; stderr is empty. A first
minimal-table probe also reproduced the same results in
`TEMP/kizuki-retrieval-ceiling-probe.jsonl`. The temporary snapshot source is
`TEMP/kizuki-ceiling-snapshot-870ccdca-0eozwbfj`; its revision was extracted
using `git archive`, with dependency resolution linked to the existing local
workspace. No dependency was installed or changed.

| Direct argument | Original search/timeline | Current search/searchResult/timeline |
| --- | --- | --- |
| Options omitted or `{}` | Returns public, personal, private, null, unknown and unlabeled rows | Same |
| `ceiling: 'public'` | Public only | Public only |
| `ceiling: 'personal'` | Public and personal | Public and personal |
| `ceiling: 'private'` | All three valid labels; null/unknown/unlabeled withheld | Same |
| `ceiling: ['private']` | Returns private rows | Same |
| `ceiling: new String('private')` | Returns private rows | Same |
| `ceiling: { toString: () => 'private' }` | Returns private rows | Same |
| `ceiling: null` or unknown string | Returns no rows without a validation refusal | Same |
| `ceiling: '__proto__'` or `'constructor'` | Driver-dependent TypeError/SQLiteError | Same |

The forged array, boxed-string and object cases are real JavaScript calls to
the exported functions. TypeScript casts are unnecessary in the runtime probe.
Property-key coercion in `SENSITIVITY_ORDER[opts.ceiling]` accepts these values
as the private rank. The probe reports synthetic IDs rather than document text.

## Binding requirements and actual implementation

RFC 0002 section 8.1, lines 1446-1450, puts unlabeled material outside the
sensitivity lattice and forbids serving it to every principal, including the
owner. Section 9.2, lines 1572-1587 and 1611-1616, requires an explicit ceiling,
enforcement in the store, and no widening fallback. Architecture invariant 8
and the core instructions require missing policy information to fail closed
below adapters. None of these rules is an owner-review or promotion gate.

Pre-repair facts at the named reproduction snapshot:

- `packages/core/src/search/query.ts:12` makes `SearchOptions.ceiling` optional.
  `searchResult` defaults options to `{}` at line 140, and adds its SQL
  predicate only at lines 169-172. `search` delegates with the same default
  at lines 236-241.
- `packages/core/src/query/timeline.ts:6` makes the ceiling optional, defaults
  options to `{}` at line 73, and adds the predicate only at lines 112-115.
- `packages/core/src/query/sql.ts:50` already uses a three-label CASE with
  `ELSE NULL`. With a valid supplied ceiling it correctly withholds null and
  unknown stored labels. The omission of this predicate is the primary defect.
- `RetrievalQuery.ceiling` is already required at
  `packages/core/src/contracts/retrieval.ts:64`. The live FTS5 port validates
  it and always adds the SQL predicate at `packages/core/src/retrieval/fts5.ts:276`.
  The issue's suggestion to make that port field mandatory is therefore
  already implemented; it does not fix the separate legacy public functions.
- An adjacent input-validation defect remains at
  `packages/core/src/contracts/retrieval.ts:264`: membership uses `in`.
  The public `validateRetrievalQuery` rejects missing/null/array/object values
  but accepts `'__proto__'` and `'constructor'`. This is a confirmed malformed
  query acceptance, not evidence that those strings successfully return
  private port results. Reuse the existing own-key `isSensitivity` predicate
  from `packages/core/src/agents/types.ts:29` for query-ceiling validation.

A ceiling string is a storage filter, not an authenticated principal or grant.
A trusted caller with a `Database` capability can already issue arbitrary SQL.
This repair must not claim to solve forged agent grants or principal identity;
those belong to issue 61 and its existing owner. Public/MCP agent serving must
continue deriving its ceiling from the existing authenticated core context.

## Caller compatibility and audit behavior

The production raw-query callers are confined to core serving:

| Caller | Current behavior | Required handling |
| --- | --- | --- |
| `serving/search.ts:154` | Actual served search uses `grant.ceiling` | Keep explicit validated ceiling |
| `serving/search.ts:158` | Second uncapped search supplies identities for denial audit | Replace with bounded internal identity-only candidates |
| `serving/timeline.ts:92` | Actual served timeline uses `grant.ceiling` | Keep explicit validated ceiling |
| `serving/timeline.ts:93` | Second uncapped timeline supplies denial audit candidates | Replace with bounded internal policy-metadata candidates |
| `serving/candidates.ts:183,260` | Context candidates supply `grant.ceiling` | Keep behavior; satisfy required options type |
| `serving/retrieval.ts:33` | Port request uses explicit option or authenticated grant fallback | Make its internal options explicit when changing the shared type; no principal redesign |

CLI query and local app callers use `serveSearch`; the serving tool dispatcher
uses the authenticated serving functions. The scan found no production CLI
caller invoking the raw public search/timeline without serving policy.

The uncapped second pass is intentional audit bookkeeping. It is classified
with `collect: false`, and existing tests require `above_ceiling` and
`missing_sensitivity` denial counts while withholding identifiers and titles
from the returned envelope. Replacing these passes with a private/public
ceiling would lose some denials. Deleting the tests or inventing approximate
counts would weaken existing behavior.

Use an internal bounded candidate projection, excluded from `src/index.ts`,
`search/index.ts`, `query/index.ts`, and package exports. Search candidates need
only `doc_id` and scope; timeline candidates need an event ID or the existing
`ServableEvent` policy fields. The existing `readServableEvents` helper in
`serving/ledger.ts:75` already retrieves current labels, kinds, subjects and
times without text and applies live-event checks. Reuse it for denial decisions
rather than loading quoted text or synthesizing empty snippets.

Share the existing filters, order, and limit with the public query SQL so the
audit candidate set preserves current selection semantics. Prefer an internal
query builder and narrow projection, not a public `unsafe` option or an
unrestricted `SearchHit[]`/`TimelineEntry[]` helper. Search's derived-index
status/degradation and both passes' de-duplication remain unchanged.

## Accepted narrow ownership and implementation

The combined 57/58 fix should have one owner because both functions share SQL
policy and serving audit behavior. Candidate product paths are:

- `packages/core/src/search/query.ts` and `packages/core/src/query/timeline.ts`:
  require options and `ceiling`, capture and validate the primitive label once
  at entry, then always append the bounded SQL predicate.
- `packages/core/src/query/sql.ts`: one internal fixed-error validation helper
  may return the checked numeric rank using existing `isSensitivity`.
- `packages/core/src/serving/search.ts` and `packages/core/src/serving/timeline.ts`:
  replace the uncapped text-returning audit calls with internal projections;
  use `Omit<SearchOptions, 'ceiling'>` / equivalent for shared non-policy filters.
- A small private query-candidate module or internal exports in those query
  implementation files, explicitly absent from all public barrels. Reuse the
  existing `readServableEvents`; edit `serving/ledger.ts` only if its current
  metadata interface actually needs an additive refinement.
- `packages/core/src/serving/retrieval.ts`: remove optional-ceiling fallback
  only if required by the internal options type; callers already supply the
  authenticated grant. `serving/candidates.ts` already supplies the ceiling.
- `packages/core/src/contracts/retrieval.ts`: replace only the query-ceiling
  inherited-key membership check with the existing own-key sensitivity guard.
  Neighbor/doc/result validation patterns are adjacent findings to record,
  not an excuse for an unbounded port rewrite.
- Closest tests under `core/test/search`, `core/test/query`, and
  `core/test/serving`, plus a direct root-export regression file. Existing
  fixtures and legitimate raw-call tests must supply their intended ceiling.
  `search.test.ts:348` currently leaves the owner/unlabeled assertion as a TODO;
  convert it to a real explicit-private regression and add missing-ceiling refusal.
- A short architecture/API compatibility note documenting the now-required
  argument. No event schema, ledger schema, origin migration, public runtime
  export, agent/grant, or provider implementation change is needed.

This is a deliberate source/runtime tightening of legacy convenience APIs:
TypeScript callers omitting the ceiling stop compiling; JavaScript callers
receive a fixed validation error. It does not change `kizuki.retrieval/v1`, whose
ceiling is already required. Do not describe that tightening as completely
behavior-compatible with formerly uncapped calls.

## Acceptance requirements

Root accepted the mandatory-ceiling and internal metadata-candidate design and
assigned these paths before implementation. Acceptance requires:

1. Direct `@kizuki/core` search/searchResult/timeline calls reject omitted,
   undefined, null, unknown, inherited-key, array, boxed-string and coercible
   object ceilings before SQL, including empty-query/zero-limit branches.
2. Public/personal/private matrices return only eligible labels and never
   null, unknown or unlabeled rows, with filters/limits still applied in SQL.
3. Internal audit candidates contain no body, title, snippet or preview and
   are absent from the public runtime export surface.
4. Existing serving denial counts, withheld-ID/title redaction, scope/time
   narrowing, source consent, current-label rechecks, tombstone exclusion,
   retrieval degradation and context-packet behavior pass unchanged.
5. Typecheck, all core tests and the required composed full repository gate
   pass on the exact reviewed head. No grant/identity closure is inferred from
   these query-filter tests; issue 61 remains separately owned.
