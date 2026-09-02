import { ENTITY_PAGE_TYPES } from "../contracts/page-candidate";
import type { PageCandidate } from "../contracts/page-candidate";
import type { CaptureEvent } from "../contracts/event";
import type { ProposalInput } from "./proposals";

/**
 * A migration's typed page. The body is the owner's own prose carried over
 * verbatim rather than blockquoted: unlike a third-party capture, this text
 * came from the owner's own estate, exactly as it does for `editBody`. A
 * `---` line inside it stays inert because the page writer closes the
 * frontmatter fence first.
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

  const subjects: string[] = [];
  for (const subject of event.subjects) {
    if (!subjects.includes(subject.subject_id))
      subjects.push(subject.subject_id);
  }

  return {
    kind: (ENTITY_PAGE_TYPES as readonly string[]).includes(candidate.type)
      ? "entity"
      : "claim",
    target: candidate.target,
    body: event.text,
    frontmatter,
    provenance: [event.event_id],
    subjects,
    producer: "deterministic",
    confidence: candidate.confidence,
  };
}
