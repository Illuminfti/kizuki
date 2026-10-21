import { situationV2Assembler } from "./situation-v2";
import { personAssembler } from "./person";
import { skillAssembler } from "./skill";
import { frameworkAssembler } from "./framework";
import { procedureAssembler } from "./procedure";
import { artifactAssembler } from "./artifact";
import { conceptAssembler } from "./concept";
import type { KindAssembler } from "./kit";
import { situationAssembler } from "./situation";
import { questionAssembler } from "./question";

/**
 * One default assembler per kind, with distinct explicit card variants. A kind file adds its assembler on
 * the line under its marker; a registered kind with no assembler here has no
 * card to serve.
 */
export const KIND_ASSEMBLERS: readonly KindAssembler[] = [
  conceptAssembler,
  situationAssembler,
  // slot: quest
  questionAssembler,
  // slot: people
  personAssembler,
  // slot: skill
  skillAssembler, frameworkAssembler, procedureAssembler,
  // slot: sit2
  situationV2Assembler,
  // slot: art
  artifactAssembler,
];
