import type { Enricher } from "./enrich";
import { conflictEnricher } from "../enrich/conflict";
import { independenceEnricher } from "../enrich/independence";
import { assistanceEnricher } from "../enrich/assistance";

/** Ordered. A workstream adds one line under its marker; each enricher sees the body the ones above it left. */
export const ENRICHERS: readonly Enricher[] = [
  // slot: card
  conflictEnricher, independenceEnricher, assistanceEnricher,
  // slot: consol
];
