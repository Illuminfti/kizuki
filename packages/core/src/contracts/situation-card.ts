import {
  KNOWLEDGE_NODE_SCHEMA,
  RELATION_SCHEMA,
  cardCodec,
  coverage,
  knowledgeNode,
  knownAt,
  objectRefList,
  optionalRelation,
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
  KnowledgeNode,
  Perspective,
  Relation,
  RelationObject,
  ValidQuery,
  ViewGap,
  WorldWireKind,
  WorldWireRef,
} from "./world-card-kit";

export const SITUATION_CARD_SCHEMA = "kizuki.situation-card/v1" as const;
export const SITUATION_NODE_SCHEMA = KNOWLEDGE_NODE_SCHEMA;
export const SITUATION_RELATION_SCHEMA = RELATION_SCHEMA;

export type SituationWireKind = WorldWireKind;
export type SituationWireRef<K extends SituationWireKind = SituationWireKind> =
  WorldWireRef<K>;
export type SituationEvidenceSpan = EvidenceSpan;
export type SituationEvidenceRef = EvidenceRef;
export type SituationPerspective = Perspective;
export type SituationConfidence = Confidence;
export type SituationEpistemicKind = EpistemicKind;
export type SituationAdmissionAssessment = AdmissionAssessment;
export type SituationRelationObject = RelationObject;
export type SituationRelation = Relation;
export type SituationNode = KnowledgeNode<"situation">;
export type SituationValidQuery = ValidQuery;
export type SituationViewGap = ViewGap;
export type SituationCoverage = Coverage;

export type SituationCard = {
  readonly schema: typeof SITUATION_CARD_SCHEMA;
  readonly situation: SituationNode;
  readonly summary: CardSummary | null;
  readonly objective: SituationRelation | null;
  readonly participants: readonly SituationWireRef<"object">[];
  readonly commitments: readonly SituationRelation[];
  readonly blocker: SituationRelation | null;
  readonly recentChange: SituationRelation | null;
  readonly uncertainty: readonly SituationRelation[];
  readonly knownAt: CardKnownAt;
  readonly coverage: SituationCoverage;
};

export type SituationCardValidationResult = CardValidation<
  SituationCard,
  "situation-card"
>;

/** Snapshots untrusted JSON before validating a closed situation card. */
export const validateSituationCard: (
  input: unknown,
) => SituationCardValidationResult = cardCodec({
  schema: SITUATION_CARD_SCHEMA,
  label: "situation-card",
  fields: {
    situation: (value) => knowledgeNode(value, "situation"),
    summary,
    objective: optionalRelation,
    participants: objectRefList,
    commitments: relationList,
    blocker: optionalRelation,
    recentChange: optionalRelation,
    uncertainty: relationList,
    knownAt,
    coverage,
  },
});
