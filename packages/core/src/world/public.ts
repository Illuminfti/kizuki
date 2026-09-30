/**
 * The world-model API of `@kizuki/core`. New operations and their types are
 * exported here so `src/index.ts` never has to change for them.
 */
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
