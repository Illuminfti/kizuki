import type { WorldWireRef } from "./world-card-kit";

export const WORLD_DIFF_SCHEMA = "kizuki.world-diff/v1" as const;
export const WORLD_DIFF_FIELDS = ["perspective", "valid", "context", "assessments", "conflict"] as const;
export type WorldDiffField = typeof WORLD_DIFF_FIELDS[number];
export type WorldDiff = {
  readonly schema: typeof WORLD_DIFF_SCHEMA;
  readonly added: readonly WorldWireRef<"claim">[];
  readonly removed: readonly WorldWireRef<"claim">[];
  readonly changed: readonly { readonly claim: WorldWireRef<"claim">; readonly fields: readonly WorldDiffField[] }[];
  readonly truncated: boolean;
};
