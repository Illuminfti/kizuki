import type { Relation } from "@kizuki/core/contracts";
import { clean } from "../../../output";

/** Render every qualifier the structured relation carries; text never invents labels for node refs. */
export function relationLines(item: Relation, label = item.predicate): string[] {
  const value = item.object.kind === "literal" ? clean(item.object.value) : item.object.kind === "vocabulary" ? item.object.id : `node ${item.object.ref.token}`;
  const perspective = item.perspective;
  const who = (ref: { token: string } | null) => ref?.token ?? "unknown";
  const lines = [
    `${label}: ${value}; polarity: ${item.polarity}; claim: ${item.claim.token}`,
    `Attribution: ${perspective.mode}; ${perspective.interpretation}; subject: ${item.subject.token}; holder: ${who(perspective.holder)}; speaker: ${who(perspective.speaker)}; addressee: ${who(perspective.addressee)}.`,
    `Uncertainty: conflict ${item.conflict}; valid: ${item.valid.kind === "unknown" ? "unknown" : `${item.valid.from} to ${item.valid.until ?? "open"}`}; temporal basis: ${item.temporalBasis}.`,
    `Context: ${item.context.map((ref) => ref.token).join(", ") || "none recorded"}.`,
  ];
  for (const assessment of item.assessments) {
    lines.push(`Confidence: ${assessment.confidence.kind === "known" ? assessment.confidence.value : "unknown"}; authority: ${assessment.authority}; epistemic kind: ${assessment.epistemicKind}; independence: ${assessment.independence}; admission: ${assessment.admission.token}.`);
  }
  const seen = new Set<string>();
  for (const evidence of [...item.assessments.flatMap((a) => a.evidence), ...perspective.evidence]) {
    const key = JSON.stringify(evidence);
    if (seen.has(key)) continue;
    seen.add(key);
    const span = evidence.span;
    lines.push(`Evidence: admission ${evidence.admission.token}; event-version ${evidence.eventVersion.token}; ${span.kind === "text" ? `UTF-16 ${span.startUtf16}..${span.endUtf16}; kizuki world --operation evidence --admission ${evidence.admission.token} --event-version ${evidence.eventVersion.token} --start-utf16 ${span.startUtf16} --end-utf16 ${span.endUtf16}` : `metadata ${span.field}`}.`);
  }
  if (seen.size === 0) lines.push("Evidence: unavailable.");
  return lines;
}
