import type { Redactor } from "../../serving/redact";
import { foldLabel } from "../pipeline/collect";
import type { WorldMatches } from "../pipeline/assemble";

const CONNECTING_WORDS = new Set("a an and as at be by for from in into is it of on or that the this to with".split(" "));

function words(text: string): Set<string> {
  return new Set((foldLabel(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !CONNECTING_WORDS.has(word)));
}

/** A task is a lexical selection hint, never evidence of applicability or a new relation.
 * Input is one bounded, authorized discovery page. Score only served label text;
 * neither private labels nor text redacted for this principal may affect rank. */
export function relevantMatches(matches: WorldMatches["matches"], task: string, preview: Redactor): WorldMatches["matches"] {
  const terms = words(task);
  const ranked = matches.map(match => {
    const labelWords = new Set(match.labels.flatMap(label => [...words(preview.text(label))]));
    return { match, score: [...terms].filter(term => labelWords.has(term)).length };
  });
  const matching = ranked.filter(item => item.score > 0);
  // Preserve the existing bounded general view when there is no lexical signal.
  return (matching.length === 0 ? ranked : matching)
    .sort((a, b) => b.score - a.score || a.match.ref.token.localeCompare(b.match.ref.token))
    .map(item => item.match);
}
