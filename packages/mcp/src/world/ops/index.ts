import { conceptFragment } from "./concept";
import { describeFragment } from "./describe";
import { discoverConceptsFragment, discoverSituationsFragment } from "./discover";
import { situationFragment } from "./situation";
import { shareFragment, resumeFragment } from "./resume";
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
  // slot: KNOWN
  // slot: VIEW
  shareFragment, resumeFragment,
  // slot: QUEST
  // slot: PEOPLE
  // slot: SKILL
  // slot: ART
  // slot: OUTCOME
  // slot: DIFF
  // slot: SLICE
  // slot: ATTN
  // slot: FCST
  // slot: ATLAS
];
