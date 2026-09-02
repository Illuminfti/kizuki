import type { Database } from "bun:sqlite";
import type { CaptureEvent, SubjectRef } from "../contracts/event";
import { tableExists } from "../ledger/schema";
import { validatePageCandidate } from "../contracts/page-candidate";
import { pageCandidateProposal } from "./page-candidate";
import { fileProposal } from "./proposals";
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
      // "source" in the vault schema: a source-faithful capture, not owner prose.
      type: "source",
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
 * Entity candidates for every distinct subject, plus either the typed page an
 * event proposes through its metadata or, failing that, one source-faithful
 * capture note quoting the event text. A tombstone produces nothing: it
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

  const candidate = validatePageCandidate(event.metadata);
  if (candidate !== null && candidate.ok) {
    proposals.push(pageCandidateProposal(event, candidate.value));
  } else {
    // Fail closed: metadata that claims to be a page but does not validate
    // becomes the blockquoted capture note, never a typed page.
    proposals.push(captureNoteProposal(event));
  }
  return proposals;
}

/**
 * A source tombstone cascades to staging: every open proposal citing the event
 * is withdrawn. Promoted proposals are untouched here — canon retraction goes
 * through the owner's review queue via `cascadeTombstone`.
 */
export function withdrawForTombstone(db: Database, eventId: string): string[] {
  const withdraw = db.transaction((): string[] => {
    // Deletion proposals are exempt: they are retraction decisions provoked BY
    // a tombstone, so a tombstone must never withdraw them.
    const rows = db
      .query(
        `SELECT DISTINCT p.proposal_id AS proposal_id
           FROM proposals p, json_each(p.provenance) j
          WHERE p.status = 'pending' AND p.kind != 'deletion' AND j.value = ?`,
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

export interface TombstoneCascade {
  /** Pending proposal ids withdrawn because their source record is gone. */
  withdrawn: string[];
  /** Deletion proposal ids filed for promoted pages that cite the record. */
  retractions_filed: string[];
}

/**
 * The full tombstone rail. Proposals cite the ORIGINAL capture event ids, not
 * the tombstone's fresh id, so the cascade is keyed by the tombstone's
 * (connector_id, source_record_id): every ledger row for that record is looked
 * up, pending proposals citing any of them are withdrawn, and each promoted
 * page citing any of them gets a `deletion` proposal filed into the review
 * queue — canon changes only through an owner decision, never automatically.
 * Requires a database that holds both the ledger and staging schemas.
 */
export function cascadeTombstone(
  db: Database,
  tombstone: CaptureEvent,
): TombstoneCascade {
  const eventRows = db
    .query(
      "SELECT event_id FROM events WHERE connector_id = ? AND source_record_id = ?",
    )
    .all(tombstone.connector_id, tombstone.source_record_id) as {
    event_id: string;
  }[];
  const eventIds = new Set(eventRows.map((r) => r.event_id));
  eventIds.add(tombstone.event_id);
  const ids = [...eventIds];

  const withdrawn: string[] = [];
  for (const id of ids) withdrawn.push(...withdrawForTombstone(db, id));

  if (!tableExists(db, "canon_receipts")) {
    return { withdrawn, retractions_filed: [] };
  }
  const placeholders = ids.map(() => "?").join(", ");
  // Receipts name their claims in `claim_ids`; a promoted proposal shares its
  // id with the claim the receipted writer materialized (RFC 0002 §18.1 v4).
  const promotedPages = db
    .query(
      `SELECT DISTINCT p.proposal_id AS proposal_id, r.page_path AS page_path
         FROM canon_receipts r, json_each(r.claim_ids) c,
              proposals p, json_each(p.provenance) j
        WHERE p.proposal_id = c.value
          AND p.status = 'promoted'
          AND j.value IN (${placeholders})`,
    )
    .all(...ids) as { proposal_id: string; page_path: string }[];

  const retractions: string[] = [];
  for (const page of promotedPages) {
    const result = fileProposal(db, {
      kind: "deletion",
      // The page path minus the extension round-trips through pageRelPath, so
      // promoting this proposal targets the existing page instead of minting one.
      target: page.page_path.replace(/\.md$/, ""),
      body:
        `Source record \`${tombstone.source_record_id}\` was deleted at ` +
        `\`${tombstone.connector_id}\`; canon page \`${page.page_path}\` cites it. ` +
        "Promote to archive the page; reject to keep it.",
      frontmatter: {
        "x-connector": tombstone.connector_id,
        "x-source-record-id": tombstone.source_record_id,
        "x-page-proposal": page.proposal_id,
      },
      provenance: [tombstone.event_id],
      producer: "deterministic",
      confidence: 1,
    });
    if (result.outcome === "stored") {
      retractions.push(result.proposal.proposal_id);
    }
  }

  return { withdrawn, retractions_filed: retractions };
}
