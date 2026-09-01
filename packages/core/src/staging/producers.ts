import type { Database } from "bun:sqlite";
import type { CaptureEvent, SubjectRef } from "../contracts/event";
import type { ProposalInput } from "./proposals";

/**
 * The deterministic floor: what staging produces from an event with no LLM
 * configured. Everything here is derivable by inspection of the event, so the
 * review queue is never empty just because no model is wired up.
 */

/** Identity is a candidate, never a fact: the owner confirms a subject is a person. */
const ENTITY_CONFIDENCE = 0.5;
/** A verbatim quote of captured text is as certain as the ledger row it cites. */
const CAPTURE_CONFIDENCE = 1;

function handleOf(subjectId: string): string {
  const cut = subjectId.lastIndexOf(":");
  if (cut === -1) return subjectId;
  const local = subjectId.slice(cut + 1);
  return local.length > 0 ? local : subjectId;
}

/**
 * Prefixes every line, blank ones included, so attacker-controlled capture text
 * cannot escape the blockquote and read as canon prose. The body is written
 * after the frontmatter fence, so a `---` line in the quote stays inert.
 */
function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function entityProposal(
  event: CaptureEvent,
  subject: SubjectRef,
): ProposalInput {
  const handle = handleOf(subject.subject_id);
  return {
    kind: "entity",
    target: subject.subject_id,
    // Stable per subject, so a second sighting dedupes onto this candidate
    // instead of forking a second stub page for the same person.
    body: `Stub entity page for \`${subject.subject_id}\`.`,
    frontmatter: {
      type: "person",
      title: subject.display_name ?? handle,
      "x-handle": handle,
      "x-subject-id": subject.subject_id,
      "x-connector": event.connector_id,
    },
    provenance: [event.event_id],
    subjects: [subject.subject_id],
    producer: "deterministic",
    confidence: ENTITY_CONFIDENCE,
  };
}

function captureNoteProposal(event: CaptureEvent): ProposalInput {
  const header = `Captured from \`${event.connector_id}\` (${event.kind}) at ${event.occurred_at}.`;
  return {
    kind: "claim",
    target: null,
    body: `${header}\n\n${blockquote(event.text)}`,
    frontmatter: {
      type: "note",
      title: `Capture from ${event.connector_id} at ${event.occurred_at}`,
      "x-connector": event.connector_id,
      "x-capture-kind": event.kind,
    },
    provenance: [event.event_id],
    subjects: event.subjects.map((s) => s.subject_id),
    producer: "deterministic",
    confidence: CAPTURE_CONFIDENCE,
  };
}

/**
 * Entity candidates for every distinct subject, plus one source-faithful
 * capture note that quotes the event text. A tombstone produces nothing: it
 * withdraws proposals rather than making them.
 */
export function proposalsForEvent(event: CaptureEvent): ProposalInput[] {
  if (event.deleted) return [];

  const proposals: ProposalInput[] = [];
  const seen = new Set<string>();
  for (const subject of event.subjects) {
    if (seen.has(subject.subject_id)) continue;
    seen.add(subject.subject_id);
    proposals.push(entityProposal(event, subject));
  }
  proposals.push(captureNoteProposal(event));
  return proposals;
}

/**
 * A source tombstone cascades to staging: every open proposal citing the event
 * is withdrawn. Promoted proposals are untouched — canon retraction is a
 * separate owner decision, not an automatic one.
 */
export function withdrawForTombstone(db: Database, eventId: string): string[] {
  const withdraw = db.transaction((): string[] => {
    const rows = db
      .query(
        `SELECT DISTINCT p.proposal_id AS proposal_id
           FROM proposals p, json_each(p.provenance) j
          WHERE p.status = 'pending' AND j.value = ?`,
      )
      .all(eventId) as { proposal_id: string }[];

    const ids = rows.map((r) => r.proposal_id);
    const update = db.query(
      "UPDATE proposals SET status = 'withdrawn' WHERE proposal_id = ?",
    );
    for (const id of ids) update.run(id);
    return ids;
  });

  return withdraw();
}
