import corpus from './corpus-v3.json';
import type { QualificationCorpus } from './score';
/** Fresh pre-observation split. Not yet selected by the production qualification runner. */
export const qualificationCorpus = corpus as QualificationCorpus;
