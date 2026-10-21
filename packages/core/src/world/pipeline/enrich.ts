import type { Relation, ViewGap } from "../../contracts/concept-card";
import type { ConceptCard } from "../../contracts/concept-card";
import { relation } from "../relation";
import type { Eligible } from "./eligible";
import type { ReadFrame } from "./frame";

/** A card's derived summary text with the admissions it was built from. */
export type CardSummary = NonNullable<ConceptCard["summary"]>;

/** One eligible claim beside the wire relation projected from it. */
export interface ProjectedClaim {
  readonly eligible: Eligible;
  readonly relation: Relation;
}

/** What enrichers refine before a kind assembles its card. */
export interface CardBody {
  readonly claims: readonly ProjectedClaim[];
  /** Gaps beyond source coverage and the traversal bound; they make the card partial. */
  readonly gaps: readonly ViewGap[];
  readonly summary: CardSummary | null;
}

/**
 * Fills in what the base projection leaves `unknown`: a relation's conflict
 * and independence, the card summary, extra coverage gaps. It receives the
 * body the enrichers before it left and returns the same claims, refined.
 */
export type Enricher = (frame: ReadFrame, body: CardBody) => CardBody;

export function enrich(
  frame: ReadFrame,
  items: readonly Eligible[],
  enrichers: readonly Enricher[],
): CardBody {
  const start: CardBody = {
    claims: items.map((eligible) => ({
      eligible,
      relation: relation(frame.ctx, frame.ns, eligible),
    })),
    gaps: [],
    summary: null,
  };
  return enrichers.reduce((body, enricher) => {
    const next = enricher(frame, body);
    if (
      next.claims.length !== body.claims.length ||
      next.claims.some((claim, at) => claim.eligible !== body.claims[at]!.eligible)
    )
      throw new Error("a world enricher must not add, drop or reorder claims");
    return next;
  }, start);
}
