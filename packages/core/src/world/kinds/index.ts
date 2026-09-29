import { conceptAssembler } from "./concept";
import type { KindAssembler } from "./kit";
import { situationAssembler } from "./situation";

/**
 * One assembler per kind that has a card. A kind file adds its assembler on
 * the line under its marker; a registered kind with no assembler here has no
 * card to serve.
 */
export const KIND_ASSEMBLERS: readonly KindAssembler[] = [
  conceptAssembler,
  situationAssembler,
  // slot: quest
  // slot: people
  // slot: skill
  // slot: sit2
  // slot: art
];
