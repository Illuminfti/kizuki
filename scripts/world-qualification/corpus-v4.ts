import previous from "./corpus-v3.json";
import person from "./corpus-v4-person.json";
import type { QualificationCorpus } from "./score";

/** Seven new Person cases; all 55 non-Person v3 cases retain their original bytes and history. */
export const qualificationCorpus: QualificationCorpus = {
  ...previous,
  version: "world-kinds-20261021-v4-person",
  cases: [...previous.cases.filter(item => item.kind !== "person"), ...person],
} as QualificationCorpus;
