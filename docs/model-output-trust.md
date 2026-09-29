# Model output trust

Evidence date: 29 September 2026. This describes ledger schema 33 and the typed
extraction path (`kizuki.producer-response/v2`). It is implemented behavior, not
direction.

A model that reads captured text can repeat whatever an attacker wrote in it.
Typed extraction therefore never lets what the model wrote outrank what the
record says, and never lets one record alone create a fact about identity or
authority. Every rule below is deterministic and needs no second model.

## What is checked, and where

| Rule | Where | Effect |
| --- | --- | --- |
| A typed claim is quoted | claim writer | Every typed claim whose evidence is not the owner's own native correction is stored with `taint: quoted`, whatever the producer asked for. The page it renders into carries `taint: "quoted"`, and served chunks and packet blocks carry the stamp. |
| A literal must be grounded | admission, before journaling | A literal object contained in its cited span after normalization keeps the model's stated perspective. Otherwise the claim is admitted only as `interpretation: inferred`, `mode: uncertain`. |
| Third-party inference needs a quoted basis | admission | `health.*` and `preference.*` claims about a name the model found in the text, not a subject the host attested, are dropped as `invalid_claim` unless the literal is contained in the cited span. |
| Instruction-shaped text is not repeated | admission | A literal or rendered body that repeats an instruction-shaped span from a cited record is dropped as `invalid_claim`, unless the claim reports it with `mode: quoted`. |
| Authority meaning is held | read path and canon queue | A model-read `identity.same_as`, `identity.handle_on`, or `decision.*` claim whose literal names an owner, agent, grant, permission, policy, access or audit is held until two independent source records support it, or the owner does. |
| Corroboration counts witnesses | claim store | `corroboration` rises only when a citation adds a source record the claim did not already rest on. |

Normalization for grounding is Unicode NFKC, lower case, every run of characters
that is not a letter or digit collapsed to one space. A literal that normalizes
to nothing is not grounded.

## Held claims

A held claim is stored in the ledger with its evidence. It is invisible to
`world_view`, to canon materialization and to the write queue, so it never
becomes a page and never reaches a reader as canon or as quoted text. Receipt
and restore checks, which resolve historical support, still find it. It is released, with no action from anyone,
when the same assertion gains support from a second source record. The owner's
own correction is native support and is never held.

## Independent witnesses

One source record is one witness. A re-sync of the same record, whatever its
bytes, is the same lineage; a different record, or the same record id in a
different enrolled source, is a new witness. A claim cited by a new revision of
a record it already rests on still merges that citation as evidence, so undo and
purge see it, but its corroboration count does not change.

## Known limits

- The instruction detector is a list of shapes, not a classifier. It refuses the
  common injection idioms and leaves ordinary prose alone; a novel phrasing
  passes it and is then stopped by grounding, quoting and the authority hold.
- The authority vocabulary is a fixed list of terms. A decision that carries an
  authority meaning in other words is not held; it is still quoted.
- The host cannot tell the owner from anyone else in a record. "A subject the
  host did not attest" means a name the model minted from the text rather than a
  subject the source connector supplied.
- Two records of one source count as two witnesses. A source an attacker
  controls can therefore release an authority claim with two records; the page
  stays `taint: quoted` and `model_inference`.
- Serving stamps a quoted page on its canon chunk and packet block; it does not
  move page chunks into the separate `quoted` list that carries captured events.
