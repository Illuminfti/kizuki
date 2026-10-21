/**
 * The world-model API of `@kizuki/core`. New operations and their types are
 * exported here so `src/index.ts` never has to change for them.
 */
export { validateHistoryPage } from "../contracts/world-history";
export type { HistoryPage, StateTransition } from "../contracts/world-history";
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
