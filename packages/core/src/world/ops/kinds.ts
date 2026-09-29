export type WorldKindPopulation =
  | "typed_extraction"
  | "extraction_off"
  | "supplied_subject"
  | "connector_metadata"
  | "propose"
  | "none";

export interface WorldKindEntry {
  readonly id: string;
  readonly population: WorldKindPopulation;
}

/**
 * The kinds this build can serve. A kind not listed here does not exist for
 * `describe`, so no agent is pointed at data nothing can produce.
 */
export const WORLD_KINDS: readonly WorldKindEntry[] = Object.freeze([
  { id: "concept", population: "typed_extraction" },
  { id: "situation", population: "typed_extraction" },
]);

/** Shipped means the build has a way to fill the kind; dark means it has none turned on. */
export function worldKindState(
  population: WorldKindPopulation,
): "shipped" | "dark" {
  return population === "extraction_off" || population === "none"
    ? "dark"
    : "shipped";
}
