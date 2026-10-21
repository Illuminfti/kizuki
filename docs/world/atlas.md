# Atlas views

Atlas composes the existing authorized world operations into seven human views:
resume my work, changes, people, questions, commitments, stale evidence, and
corrections with visible impact. The home view includes all seven. It adds no
extraction, inference, or authority to the underlying assertions.

## Read a panel

```sh
kizuki world --operation atlas --panel people
kizuki world --operation atlas --panel commitments --json
```

The App World tab has native buttons for each panel. Each relation retains its
attribution, polarity, time, uncertainty, assessments and evidence references.
Evidence opens through the same evidence operation as an ordinary card.
Person statements do not imply agreement; a resolved question does not establish
understanding. Missing providers appear unavailable, and unfinished extraction,
consolidation or bounded traversal remains partial.

## Compare a retained view

First read an object and retain its issued view. Supply that object's reference,
operation and view token when requesting changes or corrections:

```sh
kizuki world --operation atlas --panel changed --focus-operation concept \
  --ref=OBJECT_TOKEN --baseline-view=VIEW_TOKEN
```

The corresponding `world_view` request uses `focus:{operation,ref}` and
`baselineView:{kind:"view",token}`. Without a baseline the panel explains that
one is required. Revoked, erased, expired or mismatched baselines all become
`baseline_unusable`, with no old refs returned. `nextView` is the underlying
DIFF baseline for the next comparison. Corrections retain owner-correction
assessments; visible added, removed or changed claims are observable impact,
not a causal assertion that every change came from one correction.

## Bounds and privacy

Atlas reads at most four visible objects per panel and retains at most twelve
whole relations per entry. Omissions add `traversal_limit`; qualifications are
never shortened. Nested operations share a two MiB support parsing budget,
at most 32 children per composition and two levels of composition. Each child
retains its independent evidence, time and baseline dependencies for the final
publication check. Ordinary panel reads do not issue retained views or displace
the reader's existing baselines. Atlas itself is not shareable or retained.

The stale-evidence panel reports Concept and Situation consolidation gaps from
their current card coverage. It does not inspect global counts or claim that
the absence of an entry proves all vault evidence is fresh. Historical Atlas
queries are explicitly unavailable; underlying cards retain their own history
operations.

## Verification

Run `packages/core/test/world/atlas.test.ts` for contracts, DIFF integration,
missing providers, one-step evidence and publication after baseline erasure.
`atlas-security.test.ts` exercises every panel under all seven hidden mutations
and a 5,000-claim corpus. The shared verification matrix exercises actual Core,
CLI text/JSON, stdio MCP, authenticated HTTP and the App host. App client tests
cover keyboard-native controls, loading/error announcements and privacy clears.
These are scripted checks; no physical-device or real-browser claim is implied.
