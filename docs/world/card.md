# Qualified cards and captured evidence

Implemented: `world_view` derives relation conflict, support independence and
learning assistance from the caller's currently permitted claims. Reads need no
model. They do not change claim authority, confidence or learning achievement.

Opposite polarities and differing definitions in overlapping valid windows
remain visible as conflicting relations. Unknown validity conservatively
qualifies a conflict. `none_observed` means that this bounded read found none
and source coverage has no gaps; incomplete source coverage or traversal remains
`unknown`. Hidden conflicting claims do not affect a reader's answer or work
counters. Coverage loads checkpoint rows only for currently visible sources,
so a hidden source's import state cannot change those counters either.

`world/lineage.ts` is the shared support-root calculation. Exact version hashes,
captured text, grounded occurrence text and source identities group dependent
supports. Recorded copies, forwards and generated material add no witness.
Unresolved lineage stays unknown and adds no root. This is conservative source
independence, not a claim of independent authorship or a detector of undeclared
paraphrases. Metadata can reduce independence; it cannot establish it. The
calculation consumes only complete, currently authorized supports and never
looks up an inaccessible purported copy parent.

Learning assistance comes from separate qualified `learning.assistance` claims
on the learning relation's exact task context, with the same actor identified
by context or attribution and compatible validity. Opposing, uncertain or
negative claims retain their qualifiers and yield `unknown`. Exposure remains
exposure; assistance never establishes mastery or an independent outcome.

`kizuki world` text renders definitions, relations, learning and assistance,
attribution, validity, confidence, conflict, evidence refs, coverage and the
known-at state. Each evidence line provides the arguments for one source read.
JSON, MCP, HTTP and the App model use the same Core semantics.

## Resolve evidence

Pass the complete text evidence ref from a relation assessment or perspective:

```json
{
  "operation": "evidence",
  "evidence": {
    "admission": { "kind": "admission", "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    "eventVersion": { "kind": "event_version", "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    "span": { "kind": "text", "startUtf16": 0, "endUtf16": 10 }
  },
  "valid": { "kind": "all" },
  "knownAt": { "kind": "current" }
}
```

The example tokens are syntactically valid absent refs, so this example returns
`not_found`. Copy the issued values from a permitted relation for a real read.

```sh
kizuki world --operation evidence --admission AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --event-version AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --start-utf16 0 --end-utf16 10 --json
```

The operation rides the existing `world_view` grant and recall purpose. It adds
no MCP tool, write path, grant default or migration. Admission, exact event
version and exact admitted UTF-16 span are revalidated on every call. A hidden,
revoked, purged, other-principal, altered-version or absent target returns the
same `not_found` result with empty canon and quoted channels. Malformed inputs
receive the ordinary audited validation refusal.

The envelope `data` contains only the evidence ref and result state; `canon`
is empty. Captured text appears only in `quoted`, with `tainted: true`, the
retained text `integrity` and returned `slice_integrity`. Source ids and private
metadata are absent from the world quoted grammar. These are stage-one evidence
refs using the existing admission and event-version kinds; the broader typed-ref
contract is separate work.

Text is expanded through the existing timeline resolver. UTF-16 anchors are
mapped into its redacted code-point stream. A span cutting through a credential
is refused; quoted text is bounded to 2,000 code points, with `truncated` stated
explicitly. The timeline resolver's 100,000-code-point offset bound applies.
Metadata spans are not supported by this operation. Historical known-at reads
remain unavailable until history support lands.

The public App route returns the evidence envelope for this operation and keeps
the existing structured card response for card and discovery operations. This
adds model access through the App host; it does not add an evidence viewer to
the browser interface.

Tests: [card fields](../../packages/core/test/world/card-fields.test.ts),
[lineage](../../packages/core/test/world/card-lineage.test.ts),
[coverage privacy](../../packages/core/test/world/card-coverage-privacy.test.ts),
[evidence and noninterference](../../packages/core/test/world/evidence.test.ts),
[adapter parity](../../packages/cli/test/world-card-parity.test.ts).
