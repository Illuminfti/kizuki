/** Private evaluator composition only; these exact modules remain disabled in the product registry. */
import { WORLD_VOCABULARY_MODULES as BASE } from "../../packages/core/src/contracts/world-vocabulary";
import { SKILL_VOCABULARY } from "../../packages/core/src/contracts/world-vocab/skill";
import { FRAMEWORK_VOCABULARY } from "../../packages/core/src/contracts/world-vocab/framework";
import { PROCEDURE_VOCABULARY } from "../../packages/core/src/contracts/world-vocab/procedure";
import { COMMITMENT_VOCABULARY } from "../../packages/core/src/contracts/world-vocab/commitment";
import { DECISION_VOCABULARY } from "../../packages/core/src/contracts/world-vocab/decision";
import { SITUATION_V2_VOCABULARY } from "../../packages/core/src/contracts/world-vocab/situation-v2";
const candidates = [SKILL_VOCABULARY, FRAMEWORK_VOCABULARY, PROCEDURE_VOCABULARY, COMMITMENT_VOCABULARY, DECISION_VOCABULARY, SITUATION_V2_VOCABULARY];
export const WORLD_VOCABULARY_MODULES = [...BASE, ...candidates.filter(module => !BASE.includes(module))];
