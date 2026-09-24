import { ENTITY_PAGE_TYPES } from "../contracts/page-candidate";
import type { PageCandidate } from "../contracts/page-candidate";
import type { CaptureEvent } from "../contracts/event";
import { DETERMINISTIC_PRODUCER_BUDGET } from "./budget";
import { MAX_PROPOSAL_BODY_CHARS } from "./proposals";
import type { ProposalInput } from "./proposals";
import { namespacedSubjectId } from "./subjects";

/** At most `units` UTF-16 units of `text`, never half of a surrogate pair. */
function headOf(text: string, units: number): string {
  const last = text.charCodeAt(units - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

/**
 * A migration's typed page. The body is the owner's own prose carried over
 * verbatim rather than blockquoted: unlike a third-party capture, this text
 * came from the owner's own estate, exactly as it does for `editBody`. A
 * `---` line inside it stays inert because the page writer closes the
 * frontmatter fence first.
 *
 * A page longer than staging files is staged as its head, marked
 * `x-body-truncated`, rather than refused: a refusal would stage nothing of
 * the page at all. The event it cites still holds the whole text.
 */
export function pageCandidateProposal(
  event: CaptureEvent,
  candidate: PageCandidate,
): ProposalInput {
  const frontmatter: ProposalInput["frontmatter"] = {
    type: candidate.type,
    title: candidate.title,
  };
  for (const key of Object.keys(candidate.extensions).sort()) {
    const value = candidate.extensions[key];
    if (value !== undefined) frontmatter[key] = value;
  }
  // The floor stamps provenance last: a candidate cannot forge where it came
  // from by shipping an extension of the same name.
  frontmatter["x-connector"] = event.connector_id;
  frontmatter["x-capture-kind"] = event.kind;
  frontmatter["x-source-record-id"] = event.source_record_id;
  // So is the cut marker: it records what staging did, and a candidate can
  // neither claim a cut that did not happen nor hide one that did.
  const truncated = event.text.length > MAX_PROPOSAL_BODY_CHARS;
  if (truncated) frontmatter["x-body-truncated"] = true;
  else delete frontmatter["x-body-truncated"];

  const subjects: string[] = [];
  for (const subject of event.subjects.slice(
    0,
    DETERMINISTIC_PRODUCER_BUDGET.maxSubjectsPerEvent,
  )) {
    const namespaced = namespacedSubjectId(event.connector_id, subject.subject_id);
    if (!subjects.includes(namespaced)) subjects.push(namespaced);
  }

  return {
    kind: (ENTITY_PAGE_TYPES as readonly string[]).includes(candidate.type)
      ? "entity"
      : "claim",
    target: candidate.target,
    body: truncated ? headOf(event.text, MAX_PROPOSAL_BODY_CHARS) : event.text,
    frontmatter,
    provenance: [event.event_id],
    subjects,
    producer: "deterministic",
    confidence: candidate.confidence,
    ...(event.sensitivity_hint === undefined
      ? {}
      : { sensitivity: event.sensitivity_hint }),
    taint: "quoted",
    authority: "connector_evidence",
  };
}
