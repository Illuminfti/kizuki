import { isPlainObject } from "../util/validate";
import { cardCodec, coverage, exact, knownAt, knowledgeNode, relation, relationList, type CardKnownAt, type Coverage, type KnowledgeNode, type Relation } from "./world-card-kit";
export const ARTIFACT_CARD_SCHEMA = "kizuki.artifact-card/v1" as const;
export type ArtifactCard = {
  readonly schema: typeof ARTIFACT_CARD_SCHEMA;
  readonly artifact: KnowledgeNode<"artifact_version">;
  readonly versionOf: Relation | null;
  readonly content: {
    readonly sha256: string | null;
    readonly mediaType: string | null;
    readonly byteLength: number | null;
  };
  readonly original: {
    readonly status: "unavailable" | "external";
  };
  readonly inspections: readonly Relation[];
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};
export const validateArtifactCard = cardCodec<ArtifactCard, "artifact-card">({
  schema: ARTIFACT_CARD_SCHEMA, label: "artifact-card", fields: {
    artifact: value => knowledgeNode(value, "artifact_version"),
    versionOf: value => value === null || relation(value),
    content: value => isPlainObject(value) && exact(value, ["sha256", "mediaType", "byteLength"]) &&
      (value.sha256 === null || typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)) &&
      (value.mediaType === null || typeof value.mediaType === "string" && value.mediaType.length <= 128) &&
      (value.byteLength === null || Number.isSafeInteger(value.byteLength) && (value.byteLength as number) >= 0),
    original: value => isPlainObject(value) && exact(value, ["status"]) && ["external", "unavailable"].includes(String(value.status)),
    inspections: relationList, knownAt, coverage,
  },
});
