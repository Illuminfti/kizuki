import type { Database } from "bun:sqlite";
import { ClaimError } from "../claims/errors";
import type { InsertClaimInput } from "../claims/store";
import { artifactSubjectId, ARTIFACT_METADATA_PREDICATES, parseArtifactMetadata, type ArtifactMetadata } from "../contracts/artifact-metadata";
import type { ClaimV2Assertion } from "../contracts/claim-v2";
import { inspectSourceGrant, sourceEventsAllowed } from "../ledger/source-grants";
import { readEvent } from "../ledger/ledger";

export function isArtifactAssertion(semantic: ClaimV2Assertion): boolean {
  return semantic.predicate.startsWith("artifact.") || semantic.predicate === "world.kind" &&
    semantic.object.kind === "vocabulary" && semantic.object.ref.id === "world/artifact_version";
}

/** Check policy before metadata. Equal digests in different source namespaces stay distinct. */
export function artifactMetadataForEvent(db: Database, eventId: string): { metadata: ArtifactMetadata; sourceKey: string } | null {
  const binding = db.query<{ source_key: string }, [string]>(
    "SELECT source_key FROM source_event_bindings WHERE event_id=?",
  ).get(eventId);
  if (!binding) return null;
  const grant = inspectSourceGrant(db, binding.source_key);
  if (!grant || grant.status !== "active" || !grant.policy.allowed_fields.includes("metadata") ||
      !grant.policy.purposes.includes("derive") || grant.connector_id !== "kizuki.markdown-folder") return null;
  if (!sourceEventsAllowed(db, [eventId], { owner: true, purpose: "derive" })) return null;
  const event = readEvent(db, eventId);
  if (!event || event.origin !== "external" || event.deleted || event.connector_id !== grant.connector_id) return null;
  const metadata = parseArtifactMetadata(event.metadata.artifact);
  if (!metadata || !event.subjects.some(subject => subject.subject_id === artifactSubjectId(metadata.sha256)) ||
      metadata.versionOf !== null && !event.subjects.some(subject => subject.subject_id === metadata.versionOf)) return null;
  return { metadata, sourceKey: binding.source_key };
}

/** The shared writer repeats this check in its transaction, including persisted drafts. */
export function validateArtifactClaim(db: Database, input: InsertClaimInput): void {
  const semantic = input.semantic;
  if (!semantic) return;
  if (semantic.subject.id.startsWith("artifact:sha256:") && semantic.predicate === "world.kind" && !isArtifactAssertion(semantic)) {
    throw new ClaimError("world_endpoint_kind", "captured artifact subject cannot change kind");
  }
  if (!isArtifactAssertion(semantic)) return;
  const fail = (): never => {
    throw new ClaimError("provenance_unresolved", "artifact assertion lacks exact connector metadata binding");
  };
  if ((ARTIFACT_METADATA_PREDICATES as readonly string[]).includes(semantic.predicate) && input.producer !== "deterministic") fail();
  // Native owner correction attests the immutable prior endpoint through the
  // ordinary correction writer. It can revise feedback or labels, never the
  // connector's content identity or move feedback to another version.
  if (input.intent === "correct" && ["artifact.feedback", "artifact.label"].includes(semantic.predicate) &&
      input.provenance.length === 1 && db.query(
        "SELECT 1 FROM native_owner_evidence WHERE event_id=? AND origin='correction'",
      ).get(input.provenance[0]!) !== null) return;
  const ref = semantic.subject;
  if (ref.kind !== "supplied" || !("namespace" in ref) || !ref.namespace || input.provenance.length === 0) return fail();
  for (const id of input.provenance) {
    const bound = artifactMetadataForEvent(db, id);
    if (!bound || bound.sourceKey !== ref.namespace.source_key || ref.id !== artifactSubjectId(bound.metadata.sha256)) return fail();
    const metadata = bound.metadata;
    const expected = semantic.predicate === "artifact.content_sha256" ? metadata.sha256
      : semantic.predicate === "artifact.media_type" ? metadata.mediaType
      : semantic.predicate === "artifact.byte_length" ? String(metadata.byteLength) : null;
    if (expected !== null && (semantic.object.kind !== "literal" || semantic.object.value !== expected ||
        semantic.polarity !== "positive" || semantic.perspective.mode !== "asserted")) fail();
    if (semantic.predicate === "artifact.version_of" && (semantic.object.kind !== "subject" || semantic.object.ref.id !== metadata.versionOf)) fail();
  }
}
