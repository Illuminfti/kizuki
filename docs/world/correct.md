# Correction modes and owner assertions over refs

Status: implemented on this branch; awaiting integration. Evidence date: 2026-09-30.

This page describes how an owner, or an agent relaying the owner, corrects a
world claim: the three modes, the claim shapes the writer takes, what each
surface accepts, and what comes back. It adds no MCP tool, no table and no
second write path. `propose` and `correct` stay the only write tools (D14).

## What a correction does

A correction of a world claim is one call to the existing correction writer.
It records the owner's statement as native evidence, files one new claim at
owner authority, retires the claim it replaces, and rewrites the claim's world
page in the same pass under one receipt. `kizuki undo RECEIPT` reverses all of
it. The new claim keeps the old claim's subject, predicate, context and
unattributed perspective mode. Claims with attributed perspectives are refused.
It is valid from the moment of the correction, and the owner's statement is
both its evidence and its rendering on the page.

| Mode | Argument | Result |
| --- | --- | --- |
| `replace_object` (default) | `object`: a literal, a vocabulary value or a node token. Absent, the statement is the literal. | The same claim with the named object. Polarity and perspective are kept. |
| `retract` | none | The owner's denial: the same claim with negative polarity. Only a claim that is not already a denial can be retracted. |
| `reclassify_mode` | `perspective_mode`: `suggested`, `hypothetical` or `questioned` | The same claim held differently, for what was an idea and not a fact. The Situation card moves it to uncertainty. |

A literal `object` no longer has to equal the statement. The statement is the
owner's words and the claim's rendering on the page; the object is the value the
claim carries. Without an `object`, the statement is the value, as before.

The old claim is retired, never edited: its meaning, its support and its source
events are unchanged, and undo makes it live again.

A denial is a claim. `retract` does not delete evidence or hide that the claim
was ever made; the card shows the owner's negative relation. Read it as "the
owner says this is not so".

## Claim shapes

Negative, contexted, hypothetical, suggested, questioned and node-object claims
are taken when they have no holder, speaker or addressee. Quoted and reported
claims are refused in every mode, including dry runs, so the original claim
stays live with its original evidence and attribution. A claim is refused as
`unsupported_assertion` with one of these reason codes:

| Reason code | Meaning |
| --- | --- |
| `classification_claim` | A `world.kind` claim classifies its subject. A second classification contradicts the first while it is live, so a classification is not corrected in place. |
| `not_an_assertion` | The claim's stored meaning is not a plain world assertion. |
| `quoted_attribution` | The claim is quoted or reported, or names a holder, speaker or addressee. The owner's statement cannot replace another perspective's words or attribution. |

The owner's target list (`inspectOwnerPageCorrectionTargets`, the App
`correction_targets` route) asks the writer's own function, so a claim is listed
as a target exactly when the writer takes it. Each entry also states
`object_kind`, `polarity` and `perspective_mode`, and an unsupported entry
carries `unsupported_code`.

Other refusals are about the request, not the claim, and use the stable code
`invalid_arguments` with a reason:

- `retract` of a claim that already denies its object.
- `reclassify_mode` to the mode the claim already has.
- A literal or vocabulary value where the predicate's vocabulary row wants a
  node, or the reverse. The refusal carries the registry code, for example
  `world_object_kind`, `world_vocabulary_value` or `world_endpoint_kind`.
- A node token the caller does not hold, or cannot read now.
- An argument that does not belong to the chosen mode.

All of these are decided before the owner's statement is recorded, so a
refusal leaves no native evidence behind.

## Node objects

`object: { kind: "node", ref: { kind: "object", token } }` names a node by an
object token from `world_view`. The token is lookup identity, not authority:
the node must still be named by a live claim whose complete support the
caller's grant and the correction purpose allow. A token from another
principal's namespace names nothing. The statement cannot mint a node: the
writer only accepts a node the world already holds.

The native evidence records the endpoints it attests. An event's
`world_target.endpoints` lists every endpoint of the new claim beyond its
subject, sorted. Restore checks the new claim against that list, so a
corrected contexted or node-object claim survives backup, restore and the purge of
the source that first named its endpoints. Older corrections carry no list and
attest only their subject, as before.

## Surfaces

| Surface | Form |
| --- | --- |
| Core | `serveCorrect(ctx, { statement, target: { world_claim }, mode, object, perspective_mode, refresh_world, dry_run })` |
| MCP `correct`, loopback `/v1/correct` | The same fields as a closed schema. `object` is a string (legacy literal) or `{ kind: "literal" \| "vocabulary" \| "node", ... }`. |
| CLI | `kizuki tell "STATEMENT" --world-claim TOKEN [--mode MODE] [--object TEXT \| --object-ref TOKEN \| --object-vocabulary ID] [--perspective-mode MODE] [--refresh-concept-ref TOKEN] [--dry-run] [--json]` |
| App | The target list shows every taken shape and how it is held. The form replaces text values. Claims that link to another item or a fixed value are listed as needing `kizuki tell` or an agent. |

Modes, typed objects and `refresh_world` need a `world_claim` target. A legacy
claim, named by `claim_id`, key or subject, refuses them.

The CLI options `--mode`, `--object*`, `--perspective-mode` and
`--refresh-concept-ref` need `--world-claim`; without it the command exits 2.

## Authority

A typed correction is filed at owner authority. An owner may make one. An agent
may make one only when its grant relays owner corrections; without the relay it
is refused before anything is recorded, in every mode. A relay is checked
against the grant as it is now, so narrowing it takes effect on the next call.
The claim's source must still allow the correction purpose. A denied or invalid
call leaves an audit row.

## Refreshed world

`refresh_world: { operation: "concept" | "situation", concept | situation: ObjectRef }`
asks for the corrected card in the same call. It needs the caller's own
`world_view` grant and is checked as a world read before anything is written.
After the commit the read runs once, as the caller, and the result comes back as
`refreshedWorld`.

- No `refresh_world`, a dry run, or nothing written: `refreshedWorld` is `null`.
- The read cannot be taken: `refreshedWorld` is an unavailable view with reason
  `storage`. The receipt and the correction stand, and the call does not report
  a failure. Read the card with `world_view` when storage recovers.

`kizuki tell --refresh-concept-ref TOKEN` prints the refreshed Concept after the
answer, with each relation's polarity and mode, and prints a stderr note if the
read was unavailable.

## Honest fallbacks

| Situation | Returned |
| --- | --- |
| Refresh cannot be read after the commit | `refreshedWorld` unavailable with reason `storage`; the correction stands. |
| Dry run | The same answer as a real call, prefixed "Would", and nothing written in any mode. |
| Classification claim | `unsupported_assertion: classification_claim`, no native evidence. |
| Quoted, reported or attributed claim | `unsupported_assertion: quoted_attribution`, no native evidence; original claim stays live. |
| Caller cannot relay the owner | Held before mutation: `correction relay is not granted`. |

## Known limits

- A correction of a claim whose world page has not been written yet is recorded
  and retires the old claim, but there is no canon receipt to undo until the
  canon loop writes the page. The corrected claim is then part of that page.
  Canon writing needs a configured model (D12), and a typed claim exists only
  once extraction has run, so in practice the page exists first.
- `retract` on a claim that already denies its object is refused. The way to
  take back an owner's own denial is `kizuki undo`.
- A dry run of a typed correction lists the pages it would rewrite but shows no
  diff, because the page is rebuilt from its admitted claims.
- The v1 correction result still carries page diffs for a relaying agent. The
  scoped v2 result that omits them belongs to the envelope workstream.
- Impact of a correction on the caller's other views (`impact`) is added by the
  known-at workstream after this one.
- The App form does not choose a mode; it edits literal values. Choosing a mode
  there needs a route key that the operation-seam workstream owns.
- A correction chains: it can be corrected again, and each step is its own
  receipt.

## Verification

```bash
bun test packages/core/test/serving/world-correct-modes.test.ts
bun test packages/mcp/test/correct-modes.test.ts packages/mcp/test/tools-list.test.ts packages/mcp/test/schema.test.ts
bun test packages/cli/test/tell-modes.test.ts packages/cli/test/tell-shapes.test.ts packages/cli/test/app-world-correction.test.ts
bun test packages/core/test/serving/world-occurrence-correction.test.ts
bun run typecheck
```
