import { observationFragment } from "./observation";
import { forecastFragment, forecastScoresFragment } from "./forecast";
import { attentionFragment } from "./attention";
import { atlasFragment } from "./atlas";
import { sliceFragment } from "./slice";
import { personFragment, findPeopleFragment } from "./person";
import { procedureFragment, findProceduresFragment, skillFragment, frameworkFragment, outcomeFragment } from "./skills";
import { historyFragment } from "./history";
import { conceptFragment } from "./concept";
import { describeFragment } from "./describe";
import { discoverConceptsFragment, discoverSituationsFragment } from "./discover";
import { situationFragment } from "./situation";
import { shareFragment, resumeFragment } from "./resume";
import { evidenceFragment } from "./evidence";
import { artifactFragment, findArtifactsFragment } from "./artifact";
import { questionFragment, findQuestionsFragment, frontierFragment } from "./question";
import { diffFragment } from "./diff";
import type { McpWorldOp } from "./types";

export type { McpWorldOp } from "./types";

/** One fragment per core operation, in the registry's order; a workstream adds its line under its own marker. */
export const MCP_WORLD_OPS: readonly McpWorldOp[] = [
  discoverConceptsFragment,
  discoverSituationsFragment,
  conceptFragment,
  situationFragment,
  describeFragment,
  // slot: CARD
  evidenceFragment,
  // slot: REFS
  observationFragment,
  // slot: KNOWN
  historyFragment,
  // slot: VIEW
  shareFragment, resumeFragment,
  // slot: QUEST
  questionFragment, findQuestionsFragment, frontierFragment,
  // slot: PEOPLE
  personFragment, findPeopleFragment,
  // slot: SKILL
  procedureFragment, findProceduresFragment, skillFragment, frameworkFragment,
  // slot: ART
  artifactFragment, findArtifactsFragment,
  // slot: OUTCOME
  outcomeFragment,
  // slot: DIFF
  diffFragment,
  // slot: SLICE
  sliceFragment,
  // slot: ATTN
  attentionFragment,
  // slot: FCST
  forecastFragment, forecastScoresFragment,
  // slot: ATLAS
  atlasFragment,
];
