import { atlasCli } from "./atlas";
import { sliceCli } from "./slice";
import { personCli, findPeopleCli } from "./person";
import { procedureCli, findProceduresCli, skillCli, frameworkCli, outcomeCli } from "./skills";
import { historyCli } from "./history";
import { conceptCli } from "./concept";
import { describeCli } from "./describe";
import { discoverCli } from "./discover";
import { situationCli } from "./situation";
import { shareCli, resumeCli } from "./resume";
import { evidenceCli } from "./evidence";
import { questionCli, findQuestionsCli, frontierCli } from "./question";
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
  { name: "evidence", cli: evidenceCli },
  // slot: KNOWN
  { name: "history", cli: historyCli },
  // slot: VIEW
  { name: "share", cli: shareCli }, { name: "resume", cli: resumeCli },
  // slot: QUEST
  { name: "question", cli: questionCli }, { name: "find_questions", cli: findQuestionsCli }, { name: "frontier", cli: frontierCli },
  // slot: PEOPLE
  { name: "person", cli: personCli }, { name: "find_people", cli: findPeopleCli },
  // slot: SKILL
  { name: "procedure", cli: procedureCli },
  { name: "find_procedures", cli: findProceduresCli },
  { name: "skill", cli: skillCli },
  { name: "framework", cli: frameworkCli },
  // slot: ART
  // slot: OUTCOME
  { name: "outcome", cli: outcomeCli },
  // slot: DIFF
  // slot: SLICE
  { name: "slice", cli: sliceCli },
  // slot: ATTN
  // slot: FCST
  // slot: ATLAS
  { name: "atlas", cli: atlasCli },
];
