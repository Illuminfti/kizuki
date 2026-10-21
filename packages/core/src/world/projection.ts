import type { PersonCard } from "../contracts/person-card";
import type {
  ConceptCard,
  ConceptCoverage,
} from "../contracts/concept-card";
import type { SituationCardV2 } from "../contracts/situation-card-v2";
import type { SituationCard } from "../contracts/situation-card";
import type { QuestionCard } from "../contracts/question-card";
import type { WorldValidQuery } from "../serving/world-view";
import type { ServeContext } from "../serving/types";
import type { WorldDependencies } from "./dependencies";
import {
  WORLD_DISCOVERY_SCAN_BUDGET,
} from "./pipeline/collect";
import { newReadFrame, type RecordedCutoff } from "./pipeline/frame";
import { readWorldCard, readWorldMatches } from "./pipeline/read";
import type { WireRef, WorldNamespace } from "./references";

export {
  MAX_WORLD_MATCHES,
  WORLD_DISCOVERY_SCAN_BUDGET,
  foldLabel,
} from "./pipeline/collect";
export {
  eligibleWorldClaim,
  type Eligible,
  type EligibleSupport,
} from "./pipeline/eligible";
export { WorldProjectionBudgetError, type ReadBudget } from "./pipeline/frame";

/**
 * The card of one handle as `kind` for the reader in `ctx`, or null. A wrapper
 * over the pipeline in `world/pipeline`: features add an enricher, a
 * collector, a grouper or a kind there, not here.
 */
export function projectWorldCard(
  ctx: ServeContext,
  ns: WorldNamespace,
  handle: string,
  kind: "concept" | "situation" | "question" | "person",
  valid: WorldValidQuery,
  dependencies?: WorldDependencies,
  cutoff?: RecordedCutoff,
  cardSchema?: string,
): ConceptCard | SituationCard | SituationCardV2 | QuestionCard | PersonCard | null {
  // Each shipped assembler builds its declared card.
  return readWorldCard(newReadFrame(ctx, ns, valid, dependencies, cutoff), handle, kind, cardSchema) as
    | ConceptCard
    | SituationCard
    | SituationCardV2
    | QuestionCard
    | PersonCard
    | null;
}

/** One page of label discovery for `kind`. See `readWorldMatches`. */
export function discoverWorld(
  ctx: ServeContext,
  ns: WorldNamespace,
  kind: "concept" | "situation",
  label: string,
  valid: WorldValidQuery,
  after: string | null = null,
  scanBudget: number = WORLD_DISCOVERY_SCAN_BUDGET,
  dependencies?: WorldDependencies,
): {
  schema: "kizuki.concept-matches/v1" | "kizuki.situation-matches/v1";
  matches: readonly { ref: WireRef<"object">; labels: readonly string[] }[];
  cursor: string | null;
  coverage: ConceptCoverage;
} {
  return readWorldMatches(
    newReadFrame(ctx, ns, valid, dependencies),
    kind,
    label,
    after,
    scanBudget,
  );
}
