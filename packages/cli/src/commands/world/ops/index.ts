import { conceptCli } from "./concept";
import { describeCli } from "./describe";
import { discoverCli } from "./discover";
import { situationCli } from "./situation";
import type { WorldCliEntry } from "./types";

export type { WorldCliEntry, WorldCliOp } from "./types";

/** One entry per core operation, in the registry's order; a workstream adds its line under its own marker. */
export const WORLD_CLI_OPS: readonly WorldCliEntry[] = [
  { name: "find_concepts", cli: discoverCli },
  { name: "find_situations", cli: discoverCli },
  { name: "concept", cli: conceptCli },
  { name: "situation", cli: situationCli },
  { name: "describe", cli: describeCli },
  // slot: CARD
  // slot: KNOWN
  // slot: VIEW
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
