# Exact artifact versions

Evidence date: 21 October 2026. ART supplies exact-version metadata through the
existing World pipeline. It stores ordinary typed claims and support; it adds
no media store, model endpoint, claim store, or canon writer.

## Capture and authority

The local `kizuki.markdown-folder` connector supplies artifact metadata. Its
existing bounded file reader hashes the exact bytes it opened, including any
UTF-8 BOM, and records their byte length. Captured text keeps the connector's
existing BOM handling. The mapper sets `text/markdown`; frontmatter and captured
text cannot override any artifact metadata field.

The frozen `kizuki.event/v1` envelope is unchanged. The mapper adds an exact
version subject, `artifact:sha256:<lowercase digest>`, beside the existing logical
document subject, and writes this extension:

```ts
metadata.artifact = {
  sha256: string,       // SHA-256 of exact captured file bytes
  mediaType: "text/markdown",
  byteLength: number,
  versionOf: string,   // existing logical document subject
  original: "external"
};
```

Other connectors do not currently have a supported artifact mapper. Arbitrary
source-declared metadata is ignored. This slice does not add image, PDF, audio,
video, attachment retention, or visual inspection. Empty captured text cannot
supply a text-anchored admission and remains unavailable as an artifact card.
The original user file stays in its existing location.

A bounded background World job checks the source's active metadata and derive
permissions before reading the artifact extension. It maps that metadata into
ordinary typed admissions through the shared claim writer. Each pass considers
at most 32 event IDs and uses the existing cycling rail cursor. Exact retries
do not duplicate support. Policy changes are rechecked on each pass. There is
no model request, and a vault without a model writes no canon.

The writer checks exact metadata binding again in its transaction. Digest,
media type, and byte length assertions from model or agent producers are
refused even when they match the captured values. Every artifact assertion
must identify its captured digest and source namespace. Artifact subjects
cannot change kind. Native owner correction may revise an asserted label or
feedback through the existing correction receipt; it cannot alter metadata or
move feedback to another version. Quoted attribution retains the shared
correction restrictions.

## Read contract

`world/artifact_version` registers six predicates: `artifact.label`,
`artifact.content_sha256`, `artifact.media_type`, `artifact.byte_length`,
`artifact.version_of`, and `artifact.feedback`. The population path is connector
metadata. `offeredToProducer` stays false pending root qualification; no
extraction capability is enabled by this change.

`find_artifacts` accepts optional `label` and `cursor`. `artifact_version`
accepts `artifact: ObjectRef` and the standard valid-time, known-time and
retained-view fields. Both are `world_view` operations, available through Core,
CLI, MCP, HTTP, and the local App's Artifacts tab. The existing share/resume
operations also support an artifact card. MCP still exposes ten tools and the
two existing write tools.

```sh
kizuki world --operation find_artifacts --label "" --json
kizuki world --operation artifact_version --ref TOKEN --json
```

`kizuki.artifact-card/v1` returns the artifact node, its logical `versionOf`
relation, digest/media type/byte length, attributable `inspections`, known-time
coverage, and `original.status`. The shipped reader reports `unavailable`
because it has no authorized original-media retrieval operation. The contract
also reserves `external`; neither state claims ownership or visual inspection.
Feedback is evidence with ordinary perspective and source spans, not proof
that Kizuki inspected a visual original. Conflicting metadata fields become
unknown rather than selecting an arbitrary value.

Different digests have different version subjects. Equal digests from two
sources retain separate source namespaces, support and annotations. Identity
resolution does not join artifact versions. A critique on v1 therefore cannot
appear on v2 or on a same-byte copy in another source.

## Lifecycle and verification

Reads use the shared source and agent policy, recorded-time, retained-view,
evidence, and purge paths. Source revocation removes the next readable card;
purge invalidates its refs and retained views and erases dependent support.
Rebuild and export/restore use the existing claims and ledger. Deleting an
external file is subject to the connector's ordinary tombstone handling;
Kizuki purge does not delete the user's external original.

Executable product tests in `packages/core/test/world/artifacts.test.ts` bind
the `world-artifact-binding`, `world-artifact-content-binding`, and
`world-artifact-text-region` fixtures to same-source v1/v2 cards and actual
quoted evidence spans. The design fixture files remain labeled design-only;
these new tests provide the separate product execution evidence. Security
fixtures prove same-byte source isolation in output and work, metadata grant
removal, revocation, purge, rebuild, and export/restore. Connector tests cover
exact bytes, BOM, hostile frontmatter, rename, and ordinary conformance.

CLI and MCP tests exercise real subprocess/transport and HTTP/App-route parity.
The App test drives the shipped client in its DOM harness, including hostile
feedback, share and privacy invalidation. It is interaction evidence, not a
native browser visual or device claim. Root integration owns the composed
continuous matrix, full repository verification, runtime deployment, and real
model qualification.
