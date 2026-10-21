import { attentionFragment } from "./attention";
import { personFragment, findPeopleFragment } from "./person";
import { historyFragment } from "./history";
import { conceptFragment } from "./concept";
import { describeFragment } from "./describe";
import { discoverConceptsFragment, discoverSituationsFragment } from "./discover";
import { situationFragment } from "./situation";
import { shareFragment, resumeFragment } from "./resume";
import { evidenceFragment } from "./evidence";
import { questionFragment, findQuestionsFragment, frontierFragment } from "./question";
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
  // slot: KNOWN
  historyFragment,
  // slot: VIEW
  shareFragment, resumeFragment,
  // slot: QUEST
  questionFragment, findQuestionsFragment, frontierFragment,
  // slot: PEOPLE
  personFragment, findPeopleFragment,
  // slot: SKILL
  // slot: ART
  // slot: OUTCOME
  // slot: DIFF
  // slot: SLICE
  // slot: ATTN
  attentionFragment,
  // slot: FCST
  // slot: ATLAS
];
