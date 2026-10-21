import corpus from './corpus-v3.json';
import type { QualificationCorpus } from './score';
/** Fresh pre-observation split. Selected by the qualification runner; no provider result is implied. */
export const qualificationCorpus = corpus as QualificationCorpus;
