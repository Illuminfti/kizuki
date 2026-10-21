import type { ConceptCoverage, Relation } from "../../contracts/concept-card";
import type { CardSummary } from "../pipeline/enrich";
import { WorldProjectionBudgetError, type ReadFrame } from "../pipeline/frame";
import type { Cluster } from "../pipeline/group";
import type { WireRef } from "../references";

const CARD_BYTE_LIMIT = 256 * 1024;

/** The node every card of every kind opens with. The assembler narrows `kind` to its own literal. */
export interface CardNode {
  readonly schema: "kizuki.knowledge-node/v1";
  readonly ref: WireRef<"object">;
  readonly kind: string;
  readonly classificationClaims: readonly WireRef<"claim">[];
  readonly labels: readonly { text: string; claim: WireRef<"claim"> }[];
  readonly resolution: Cluster["resolution"];
}

/** What the pipeline hands a kind assembler; the assembler decides only how this kind lays it out. */
export interface CardInput {
  readonly frame: ReadFrame;
  readonly node: CardNode;
  /** Relations whose subject is the requested endpoint. */
  readonly own: readonly Relation[];
  /** Every relation the read projected, including those about other endpoints that point here. */
  readonly relations: readonly Relation[];
  readonly summary: CardSummary | null;
  readonly coverage: ConceptCoverage;
}

/** What every assembled card carries, whatever its kind. */
export interface AssembledCard {
  readonly schema: string;
  readonly coverage: ConceptCoverage;
}

/** Lays out one kind's card. It never reads the ledger: everything it needs is in the input. */
export interface KindAssembler {
  /** The `WorldKindSpec.id` this assembler serves. */
  readonly kind: string;
  assemble(input: CardInput): AssembledCard;
}

/**
 * The last step of every assembler: an oversized card is never served in part,
 * and a card its own codec rejects is a bug in the assembler, not a result.
 */
export function sealCard<Card>(
  card: Card,
  validate: (input: unknown) => { readonly ok: boolean },
  label: string,
): Card {
  if (Buffer.byteLength(JSON.stringify(card), "utf8") > CARD_BYTE_LIMIT)
    throw new WorldProjectionBudgetError();
  if (!validate(card).ok)
    throw new Error(`world ${label} projection violated its codec`);
  return card;
}
