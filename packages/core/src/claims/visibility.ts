import type { Claim } from "../contracts/proposal";

/** Candidate admission before materialization; the reader checks live evidence afterward. */
export interface ClaimVisibility {
  sql: string;
  bindings: (string | number)[];
  canRead(claim: Claim): boolean;
}
