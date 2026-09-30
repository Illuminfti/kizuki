import type { ConceptCoverage } from "../../contracts/concept-card";
import type { WorldOpData, WorldOpOutcome } from "./types";

export const NOT_FOUND: WorldOpOutcome = Object.freeze({ status: "not_found" });

/** A card or page whose own coverage decides whether the answer is complete. */
export function coveredOutcome(
  data: WorldOpData & { readonly coverage: ConceptCoverage },
): WorldOpOutcome {
  return {
    status: "data",
    data,
    gaps: data.coverage.status === "partial" ? data.coverage.gaps : null,
  };
}
