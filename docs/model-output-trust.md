# Model output trust

Evidence date: 30 September 2026. This describes ledger schema 35 and the typed
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
| A literal must be grounded | admission, before journaling | A literal object contained in its cited span after normalization, on whole-token boundaries, keeps the model's stated perspective. Otherwise the claim is admitted only as `interpretation: inferred`, `mode: uncertain`. |
| Person state needs a quoted basis | admission | `health.*` and `preference.*` claims are dropped as `invalid_claim` unless the literal contains at least two tokens and is contained in the cited span. The host cannot tell the owner from a contact, so no subject is exempt; the owner states such a fact through a correction. |
| Instruction-shaped text is not repeated | admission | A literal or rendered body, for a claim of any object kind, that repeats an instruction-shaped span from a cited record is dropped as `invalid_claim`, unless the claim reports it with `mode: quoted`. A role label such as `Operating system: Linux` is not a turn and is not matched; a role marker counts only at a sentence or line start with text after the colon. |
| Authority meaning is held | read path and canon queue | A model-read `identity.same_as` or `identity.handle_on` claim, a `decision.*` claim whose literal names an owner, agent, grant, permission, policy, access or audit, or any claim whose rendered page body uses an authority term, is held until two independent sources support it, or the owner does. |
| Corroboration counts witnesses | claim store and staging | `corroboration` rises only when a citation adds a source record the claim did not already rest on, on both the typed and the staged path. |

Normalization for grounding is Unicode NFKC, lower case, every run of characters
that is not a letter or digit collapsed to one space. A literal that normalizes
to nothing is not grounded, and a literal is grounded only as whole tokens: `ill`
is not in `will`, and `5` is not in `15`.

An ungrounded literal cannot preserve instruction text by arriving as a
quotation: if becoming uncertain would remove the quotation mode from an
instruction repeat in either the literal or the body, the claim is dropped.

## Held claims

A held claim is stored in the ledger with its evidence. It is invisible to
`world_view`, to canon materialization and to the write queue, so it never
becomes a page and never reaches a reader as canon or as quoted text. Receipt
and restore checks, which resolve historical support, still find it. It is
released when the same claim gains support from a second enrolled source, or
when the owner supports it. Two records of one source are one root, because one
attacker-controlled inbox can send both. The owner's own correction is native
support and is never held.

Each source names its subjects in its own namespace, so a second source that
states the same thing writes its own claim rather than adding support to the
first. Both are held. In practice the owner's correction is what releases a
held claim today; the two-source count is in place for when sources share a
subject namespace.

## Independent witnesses

One source record is one witness for the corroboration count. A re-sync of the
same record, whatever its bytes, is the same lineage; a different record, or the
same record id in a different enrolled source, is a new witness. A claim cited by
a new revision of a record it already rests on still merges that citation as
evidence, so undo and purge see it, but its corroboration count does not change.
The authority hold is stricter: it counts enrolled sources, not records.

## Known limits

- The instruction detector is a list of shapes, not a classifier. It refuses the
  common injection idioms and leaves ordinary prose alone; a novel phrasing
  passes it; external model prose still stays quoted, and authority terms still
  trigger the hold.
- The authority vocabulary is a fixed list of terms. A decision that carries an
  authority meaning in other words is not held; it is still quoted.
- Authority terms in the body are conservative: harmless uses can also be held
  until corroboration or owner support.
- Context packets place quoted page chunks in `quoted`, with their page IDs,
  source provenance and `tainted: true`. They never invent captured event IDs.
  Packet Markdown places their excerpts under the quoted-capture heading and
  prefixes every line as a quotation.
