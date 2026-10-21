import { ARTIFACT_CARD_SCHEMA, validateArtifactCard, type ArtifactCard } from "../../contracts/artifact-card";
import { sealCard, type KindAssembler } from "./kit";

export const artifactAssembler: KindAssembler = {
  kind: "artifact_version", consolidation: false,
  sliceConstraint: relation => ["artifact.version_of", "artifact.feedback"].includes(relation.predicate),
  assemble({ node, own, coverage }) {
    const asserted = own.filter(row => row.polarity === "positive" && row.perspective.mode === "asserted");
    const literal = (predicate: string): string | null => {
      const values = [...new Set(asserted.filter(row => row.predicate === predicate && row.object.kind === "literal")
        .map(row => row.object.kind === "literal" ? row.object.value : ""))];
      return values.length === 1 ? values[0]! : null;
    };
    const sha256 = literal("artifact.content_sha256"), mediaType = literal("artifact.media_type"), length = literal("artifact.byte_length");
    const versionOf = asserted.filter(row => row.predicate === "artifact.version_of");
    const card: ArtifactCard = {
      schema: ARTIFACT_CARD_SCHEMA, artifact: { ...node, kind: "artifact_version" },
      versionOf: versionOf.length === 1 ? versionOf[0]! : null,
      content: {
        sha256, mediaType,
        byteLength: length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null,
      },
      original: { status: "unavailable" }, inspections: own.filter(row => row.predicate === "artifact.feedback"),
      knownAt: { kind: "current" }, coverage,
    };
    return sealCard(card, validateArtifactCard, "artifact");
  },
};
