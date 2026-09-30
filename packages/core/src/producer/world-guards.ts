import type { ClaimV2Assertion } from "../contracts/claim-v2";

/**
 * Model output over captured text is only as good as its span. These checks
 * are deterministic and need no second model: they compare what the model
 * wrote with the exact text it cited.
 */

/** Case, accents, punctuation and spacing are not evidence of a different claim. */
export function normalizeForGrounding(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * True when the normalized literal appears in one of the cited spans as whole
 * tokens. A substring test would ground "ill" in "will" and "no" in "know".
 */
export function literalGrounded(literal: string, spans: readonly string[]): boolean {
  const wanted = ` ${normalizeForGrounding(literal)} `;
  return wanted.length > 2 && spans.some(span => ` ${normalizeForGrounding(span)} `.includes(wanted));
}

const INSTRUCTION_SHAPES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules?|messages?)\b/gi,
  /\bnew (?:system )?instructions?\s*:/gi,
  // A role marker opens a turn: sentence or line start, then text after the colon.
  // "Operating system: Linux" is a label, not a turn, and never matches.
  /(?:^|[\n.!?"'>])[ \t]*(?:system|assistant|developer)[ \t]*:[ \t]*\S[^\n]{0,80}/gi,
  /<<<\s*kz[^>]{0,256}>>>|<\|(?:im_start|im_end|system)\|>/gi,
  /\byou (?:must|should|shall|will) (?:now )?(?:ignore|obey|grant|delete|reveal|disclose|forward|execute|run)\b/gi,
  /\b(?:grant|give)s? (?:yourself |me |them |everyone |every agent |all agents )?(?:admin|root|full|unrestricted)\b/gi,
  /\b(?:reveal|print|repeat|disclose) (?:your |the )?(?:system prompt|instructions|credentials|secrets?)\b/gi,
  /\bdo not (?:tell|inform|alert) the (?:user|owner)\b/gi,
];

/** Every instruction-shaped span in `text`, as written. */
export function instructionShapedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const shape of INSTRUCTION_SHAPES) {
    for (const match of text.matchAll(shape)) spans.push(match[0].replace(/^[\n.!?"'>\s]+/, "").trim());
  }
  return spans;
}

/** The instruction-shaped spans of one record, normalized for comparison. */
export function normalizedInstructionSpans(text: string): string[] {
  return instructionShapedSpans(text).map(normalizeForGrounding).filter(span => span.length > 0);
}

/**
 * True when `rendered` repeats one of the normalized instruction-shaped spans
 * found in the events it cites. Repeating it verbatim turns attacker text into
 * the claim's own voice.
 */
export function repeatsInstruction(rendered: string, instructionSpans: readonly string[]): boolean {
  if (instructionSpans.length === 0) return false;
  const text = normalizeForGrounding(rendered);
  return instructionSpans.some(span => text.includes(span));
}

/** Predicates that state something about a person's inner state or health. */
export function isPersonStatePredicate(predicate: string): boolean {
  return predicate.startsWith("health.") || predicate.startsWith("preference.");
}

/** What a claim cites: the exact spans it anchors and the instruction-shaped spans of the whole records they sit in. */
export interface CitedEvidence {
  readonly spans: readonly string[];
  readonly instructionSpans: readonly string[];
}

/**
 * Applies the rules to one resolved claim. Returns the assertion to admit,
 * possibly downgraded, or null when it must be refused.
 *
 * - A claim whose rendered body, or whose literal, repeats an instruction-shaped
 *   span from its own evidence is refused unless it reports it as a quotation.
 *   The body is the page text, so this holds for every object kind.
 * - A literal that is not contained in its cited span is an interpretation, not
 *   a reading: it is admitted only as inferred and uncertain.
 * - Health and preference claims need a literal quoted from the span. The host
 *   cannot tell the owner from anyone else, so no subject is exempt; the owner
 *   states such a fact through a correction.
 */
export function guardClaim(semantic: ClaimV2Assertion, body: string, cited: CitedEvidence): ClaimV2Assertion | null {
  const quoted = semantic.perspective.mode === "quoted";
  if (!quoted && repeatsInstruction(body, cited.instructionSpans)) return null;
  if (semantic.object.kind !== "literal") return isPersonStatePredicate(semantic.predicate) ? null : semantic;
  if (!quoted && repeatsInstruction(semantic.object.value, cited.instructionSpans)) return null;
  if (isPersonStatePredicate(semantic.predicate) && normalizeForGrounding(semantic.object.value).split(" ").length < 2) return null;
  if (literalGrounded(semantic.object.value, cited.spans)) return semantic;
  if (isPersonStatePredicate(semantic.predicate)) return null;
  return { ...semantic, perspective: { ...semantic.perspective, interpretation: "inferred", mode: "uncertain" } };
}
