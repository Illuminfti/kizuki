import { isPlainObject } from "../util/validate";
import {
  KNOWLEDGE_NODE_SCHEMA,
  RELATION_SCHEMA,
  cardCodec,
  coverage,
  exact,
  knowledgeNode,
  knownAt,
  relation,
  relationList,
  summary,
} from "./world-card-kit";
import type {
  AdmissionAssessment,
  CardKnownAt,
  CardSummary,
  CardValidation,
  Confidence,
  Coverage,
  EpistemicKind,
  EvidenceRef,
  EvidenceSpan,
  KnowledgeNode as KitKnowledgeNode,
  Perspective,
  Relation,
  RelationObject,
} from "./world-card-kit";

export const CONCEPT_CARD_SCHEMA = "kizuki.concept-card/v1" as const;
export { KNOWLEDGE_NODE_SCHEMA, RELATION_SCHEMA };
export type {
  Relation,
  ValidQuery,
  ViewGap,
  WorldWireKind,
  WorldWireRef,
} from "./world-card-kit";

export type ConceptEvidenceSpan = EvidenceSpan;
export type ConceptEvidenceRef = EvidenceRef;
export type ConceptPerspective = Perspective;
export type ConceptConfidence = Confidence;
export type ConceptEpistemicKind = EpistemicKind;
export type ConceptAdmissionAssessment = AdmissionAssessment;
export type ConceptRelationObject = RelationObject;
export type KnowledgeNode = KitKnowledgeNode<"concept">;
export type ConceptCoverage = Coverage;

export type ConceptLearningFacet =
  | "exposure"
  | "explanation"
  | "application"
  | "demonstration";

export type ConceptLearning = {
  readonly facet: ConceptLearningFacet;
  readonly assertion: Relation;
  readonly assistance: "assisted" | "unassisted" | "unknown";
  readonly assistanceEvidence: readonly Relation[];
};

export type ConceptCard = {
  readonly schema: typeof CONCEPT_CARD_SCHEMA;
  readonly concept: KnowledgeNode;
  readonly summary: CardSummary | null;
  readonly definitions: readonly Relation[];
  readonly relations: readonly Relation[];
  readonly learning: readonly ConceptLearning[];
  readonly knownAt: CardKnownAt;
  readonly coverage: ConceptCoverage;
};

export type ConceptCardValidationResult = CardValidation<
  ConceptCard,
  "concept-card"
>;

const FACETS = new Set<ConceptLearningFacet>([
  "exposure",
  "explanation",
  "application",
  "demonstration",
]);

function learning(value: unknown): value is ConceptLearning {
  return (
    isPlainObject(value) &&
    exact(value, ["facet", "assertion", "assistance", "assistanceEvidence"]) &&
    FACETS.has(value.facet as ConceptLearningFacet) &&
    relation(value.assertion) &&
    (value.assistance === "assisted" ||
      value.assistance === "unassisted" ||
      value.assistance === "unknown") &&
    relationList(value.assistanceEvidence)
  );
}

/** Snapshots untrusted JSON before validating a closed concept card. */
export const validateConceptCard: (
  input: unknown,
) => ConceptCardValidationResult = cardCodec({
  schema: CONCEPT_CARD_SCHEMA,
  label: "concept-card",
  fields: {
    concept: (value) => knowledgeNode(value, "concept"),
    summary,
    definitions: relationList,
    relations: relationList,
    learning: (value) =>
      Array.isArray(value) && value.length <= 256 && value.every(learning),
    knownAt,
    coverage,
  },
});
