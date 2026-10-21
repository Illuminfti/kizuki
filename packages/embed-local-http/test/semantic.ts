/**
 * A stand-in for a real embedding model, small enough to read. It knows thirteen
 * concepts, each spelled several ways, and places a text near the concepts it
 * mentions no matter which spelling it uses. That is the one property that
 * separates a semantic model from full-text search: two texts about the same
 * thing in different words land close together.
 *
 * It is a test double for the wiring and the ranking path. It says nothing
 * about how a real model scores on real notes.
 */
export const CONCEPTS: readonly (readonly string[])[] = [
  ["car", "automobile", "sedan", "vehicle", "driving"],
  ["money", "cash", "funds", "payment", "budget"],
  ["sick", "ill", "unwell", "illness", "fever"],
  ["house", "home", "residence", "apartment", "dwelling"],
  ["meal", "dinner", "food", "lunch", "cooking"],
  ["trip", "journey", "travel", "voyage", "flight"],
  ["job", "employer", "hiring", "career", "recruit"],
  ["dog", "puppy", "canine", "hound", "kennel"],
  ["song", "melody", "music", "tune", "concert"],
  ["storm", "hurricane", "tempest", "gale", "thunder"],
  ["book", "novel", "literature", "reading", "library"],
  ["doctor", "physician", "clinic", "hospital", "nurse"],
  ["kettle", "teapot", "samovar", "brew", "tea"],
];

export const SEMANTIC_DIMS = CONCEPTS.length + 4;

const CONCEPT_OF = new Map<string, number>(
  CONCEPTS.flatMap((words, index) => words.map((word) => [word, index] as const)),
);

export function semanticVector(text: string): number[] {
  const vector = new Array<number>(SEMANTIC_DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const concept = CONCEPT_OF.get(token);
    if (concept !== undefined) {
      vector[concept] = (vector[concept] ?? 0) + 1;
      continue;
    }
    // Words outside the lexicon only add a little hashed noise.
    let hash = 0;
    for (let at = 0; at < token.length; at += 1) hash = (hash * 31 + token.charCodeAt(at)) >>> 0;
    const slot = CONCEPTS.length + (hash % 4);
    vector[slot] = (vector[slot] ?? 0) + 0.05;
  }
  return vector;
}
