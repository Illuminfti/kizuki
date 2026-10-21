export { validateProcedureCard } from "../contracts/procedure-card";
export type { ProcedureCard } from "../contracts/procedure-card";
export { validateSkillCard } from "../contracts/skill-card";
export type { SkillCard } from "../contracts/skill-card";
export { validateFrameworkCard } from "../contracts/framework-card";
export type { FrameworkCard } from "../contracts/framework-card";
export { validateOutcomeCard } from "../contracts/outcome-card";
export type { OutcomeCard } from "../contracts/outcome-card";
export type { ProcedureUsefulness, OutcomeEvidence, OutcomeEvaluation } from "../contracts/outcome-card";
export { ARTIFACT_CARD_SCHEMA, validateArtifactCard } from "../contracts/artifact-card";
export type { ArtifactCard } from "../contracts/artifact-card";
/**
 * The world-model API of `@kizuki/core`. New operations and their types are
 * exported here so `src/index.ts` never has to change for them.
 */
export { SITUATION_CARD_V2_SCHEMA, validateSituationCardV2 } from "../contracts/situation-card-v2";
export type { SituationCardV2, CommitmentEntry, DecisionEntry } from "../contracts/situation-card-v2";
export { validateHistoryPage } from "../contracts/world-history";
export type { HistoryPage, StateTransition } from "../contracts/world-history";
export { WORLD_DIFF_SCHEMA, WORLD_DIFF_FIELDS } from "../contracts/world-diff";
export type { WorldDiff, WorldDiffField } from "../contracts/world-diff";
export { PERSON_CARD_SCHEMA, validatePersonCard } from "../contracts/person-card";
export type { PersonCard, PersonPerspective } from "../contracts/person-card";
export { QUESTION_CARD_SCHEMA, validateQuestionCard } from "../contracts/question-card";
export type { QuestionCard, QuestionStatus } from "../contracts/question-card";
export type { Frontier } from "./ops/frontier";
export { WORLD_DESCRIBE_SCHEMA } from "./ops/describe";
export type { WorldDescribe } from "./ops/describe";
export type { ShareData } from "./views/resume";
export { WORLD_KINDS, worldKindState } from "./ops/kinds";
export type { WorldKindEntry, WorldKindPopulation } from "./ops/kinds";
export { NOT_FOUND, coveredOutcome } from "./ops/outcome";
export {
  hasWorldKeys,
  isWorldWireToken,
  parseWorldKnownAt,
  parseWorldRef,
  parseWorldValid,
} from "./ops/parse";
export { WORLD_OPS, activeWorldOps, findWorldOp, worldOpRegistry } from "./ops/registry";
export { WorldViewError, worldOpInputKeys, worldOpKeys } from "./ops/types";
export type {
  BuildOp,
  ClaimsOp,
  ViewResult,
  ViewToken,
  WorldFrame,
  WorldKnownAt,
  WorldObjectRef,
  WorldOp,
  WorldOpData,
  WorldOpKeys,
  WorldOpOutcome,
  WorldOpRegistry,
  WorldRecord,
  WorldSnapshotRef,
  WorldUnavailableReason,
  WorldValidQuery,
  WorldViewResult,
  WorldWhen,
} from "./ops/types";
export { readWorldView, serveWorldView } from "../serving/world-view";
export type {
  WorldData,
  WorldReadInput,
  WorldReadResult,
  WorldViewEnvelope,
} from "../serving/world-view";
export type { WorldEvidenceData, WorldQuotedEvidence } from "./ops/evidence-types";
export { RESPONSE_CONTRACT_KEY, unsupportedContract, negotiateServeContract } from "../serving/contract";
export type { ResponseContract } from "../serving/contract";
export type { DispatchOptions } from "../serving/dispatch";
export { ENVELOPE_V2_SCHEMA } from "../serving/types";
export type { EnvelopeV2 } from "../serving/types";
export { PACKET_V2_SCHEMA } from "../serving/v2/context-packet";
export type { ContextPacketArgsV2, ContextPacketDataV2, PacketContentV2 } from "../serving/v2/context-packet";

export { inspectSourceCoverage, readSourceCoverage } from "./coverage";
export { verifyWorldCopy } from "./verify";
export type { WorldIntegrityReport } from "./verify";
export type { SourceCoverageReport } from "./coverage";
export type { ScanCoverage, PassCoverage } from "../contracts/source-coverage";

export { WORLD_SLICE_SCHEMA, validateWorldSlice, type WorldSlice, type SliceItem, type ProviderCoverage } from "../contracts/world-slice";

export { ATLAS_SCHEMA, ATLAS_PANELS, ATLAS_OBJECT_OPERATIONS, validateAtlas, type Atlas, type AtlasPanel, type AtlasEntry, type AtlasPanelName, type AtlasObjectOperation } from "../contracts/atlas";
