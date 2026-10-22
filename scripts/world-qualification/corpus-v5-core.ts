import corpus from "./corpus-v5-core.json";
import type { QualificationCorpus } from "./score";

/** Independently sealed core-only split. Selection permits evaluation, not activation. */
export const qualificationCorpus = corpus as QualificationCorpus;
