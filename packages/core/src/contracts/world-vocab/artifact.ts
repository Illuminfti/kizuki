import { ARTIFACT_CARD_SCHEMA } from "../artifact-card";
import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";

export const ARTIFACT_VOCABULARY: WorldVocabularyModule = {
  kind: {
    id: "artifact_version", vocabularyId: "world/artifact_version", labelPredicate: "artifact.label",
    pageType: "topic", endpointKind: "artifact_version", cardSchema: ARTIFACT_CARD_SCHEMA,
    offeredToProducer: false, population: ["connector_metadata"],
  },
  predicates: [
    ...["label", "content_sha256", "media_type", "byte_length"].map(name => worldPredicate({
      predicate: `artifact.${name}`, subject: "artifact_version", objects: ["literal"],
    })),
    worldPredicate({ predicate: "artifact.version_of", subject: "artifact_version", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "artifact.feedback", subject: "artifact_version", objects: ["literal", "raw_subject"] }),
  ],
};
