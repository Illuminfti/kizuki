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

/** True when the normalized literal appears in one of the cited spans. */
export function literalGrounded(literal: string, spans: readonly string[]): boolean {
  const wanted = normalizeForGrounding(literal);
  return wanted.length > 0 && spans.some(span => normalizeForGrounding(span).includes(wanted));
}

const INSTRUCTION_SHAPES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
  /\bnew (?:system )?instructions?\s*:/i,
  /(?:^|[\s"'>])(?:system|assistant|developer)\s*:/i,
  /<<<\s*kz[^>]*>>>|<\|(?:im_start|im_end|system)\|>/i,
  /\byou (?:must|should|shall|will) (?:now )?(?:ignore|obey|grant|delete|reveal|disclose|forward|execute|run)\b/i,
  /\b(?:grant|give)s? (?:yourself |me |them |everyone |every agent |all agents )?(?:admin|root|full|unrestricted)\b/i,
  /\b(?:reveal|print|repeat|disclose) (?:your |the )?(?:system prompt|instructions|credentials|secrets?)\b/i,
  /\bdo not (?:tell|inform|alert) the (?:user|owner)\b/i,
];

/** The instruction-shaped spans in `text`, as written. */
export function instructionShapedSpans(text: string): string[] {
  return INSTRUCTION_SHAPES.flatMap(shape => {
    const match = shape.exec(text);
    return match === null ? [] : [match[0].trim()];
  });
}

/**
 * True when `rendered` repeats an instruction-shaped span found in the events it
 * cites. Repeating it verbatim turns attacker text into the claim's own voice.
 */
export function repeatsInstruction(rendered: string, evidence: readonly string[]): boolean {
  const spans = evidence.flatMap(instructionShapedSpans).map(normalizeForGrounding).filter(span => span.length > 0);
  if (spans.length === 0) return false;
  const text = normalizeForGrounding(rendered);
  return spans.some(span => text.includes(span));
}

/** Predicates that state something about a person's inner state or health. */
export function isPersonStatePredicate(predicate: string): boolean {
  return predicate.startsWith("health.") || predicate.startsWith("preference.");
}

/** What a claim cites: the exact spans it anchors and the whole records they sit in. */
export interface CitedEvidence {
  readonly spans: readonly string[];
  readonly events: readonly string[];
}

/**
 * Applies the literal rules to one resolved claim. Returns the assertion to
 * admit, possibly downgraded, or null when it must be refused.
 *
 * - A literal that repeats an instruction-shaped span from its own evidence is
 *   refused unless the claim reports it as a quotation.
 * - A literal that is not contained in its cited span is an interpretation, not
 *   a reading: it is admitted only as inferred and uncertain.
 * - Health and person-state claims about a subject the host did not attest
 *   (a name the model found in the text) need a literal quoted from the span.
 */
export function guardLiteral(semantic: ClaimV2Assertion, body: string, cited: CitedEvidence): ClaimV2Assertion | null {
  if (semantic.object.kind !== "literal") return semantic;
  const { mode } = semantic.perspective;
  if (mode !== "quoted" && (repeatsInstruction(semantic.object.value, cited.events) || repeatsInstruction(body, cited.events))) return null;
  if (literalGrounded(semantic.object.value, cited.spans)) return semantic;
  if (isPersonStatePredicate(semantic.predicate) && semantic.subject.kind !== "supplied") return null;
  return { ...semantic, perspective: { ...semantic.perspective, interpretation: "inferred", mode: "uncertain" } };
}
