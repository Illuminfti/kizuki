import type { Enricher } from "./enrich";

/** Ordered. A workstream adds one line under its marker; each enricher sees the body the ones above it left. */
export const ENRICHERS: readonly Enricher[] = [
  // slot: card
  // slot: consol
];
