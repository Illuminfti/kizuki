import type { SliceItem } from "../../contracts/world-slice";
import type { Redactor } from "../../serving/redact";
import { foldLabel } from "../pipeline/collect";
import type { WorldMatches } from "../pipeline/assemble";

const CONNECTING_WORDS = new Set("a an and as at be by for from in into is it of on or that the this to with".split(" "));

function words(text: string): Set<string> {
  return new Set((foldLabel(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !CONNECTING_WORDS.has(word)));
}

/** Extract folded lexical terms from a query for bounded slice-item ranking. */
export function queryTerms(text: string | undefined, limit = 32): readonly string[] {
  if (text === undefined) return [];
  const tokens = foldLabel(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  const filtered = tokens.filter(word => !CONNECTING_WORDS.has(word));
  return [...new Set(filtered.length > 0 ? filtered : tokens)].slice(0, limit);
}

/** Score one authorized slice item against folded query terms using only redacted visible text.
 * Direct matches on the item's own object or predicate outrank inherited parent-card label matches. */
export function sliceItemRelevance(
  item: SliceItem,
  terms: readonly string[],
  redactor: Redactor,
  labels: readonly string[] = [],
): number {
  if (terms.length === 0) return 0;
  const direct = new Set<string>();
  const inherited = new Set<string>();
  const add = (target: Set<string>, text: string) => {
    for (const word of foldLabel(text).match(/[\p{L}\p{N}_]+/gu) ?? []) target.add(word);
  };
  const value = item.relation.object;
  if (value.kind === "literal") add(direct, redactor.text(value.value));
  else if (value.kind === "vocabulary") add(direct, value.id);
  add(direct, item.relation.predicate);
  for (const label of labels) add(inherited, redactor.text(label));
  let score = 0;
  for (const term of terms) {
    if (direct.has(term)) score += 4;
    if (inherited.has(term)) score += 1;
  }
  return score;
}

/** A task is a lexical selection hint, never evidence of applicability or a new relation.
 * Input is one bounded, authorized discovery page. Score only served label text;
 * neither private labels nor text redacted for this principal may affect rank. */
export function relevantMatches(matches: WorldMatches["matches"], task: string, preview: Redactor, fallback = true): WorldMatches["matches"] {
  const terms = words(task);
  const ranked = matches.map(match => {
    const labelWords = new Set(match.labels.flatMap(label => [...words(preview.text(label))]));
    return { match, score: [...terms].filter(term => labelWords.has(term)).length };
  });
  const matching = ranked.filter(item => item.score > 0);
  // Preserve the existing bounded general view when there is no lexical signal.
  return (matching.length === 0 && (fallback || terms.size === 0) ? ranked : matching)
    .sort((a, b) => b.score - a.score || a.match.ref.token.localeCompare(b.match.ref.token))
    .map(item => item.match);
}
