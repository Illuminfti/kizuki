import { subjectPageType } from "../vault/subject-type";
import type { Database } from "bun:sqlite";
import type { CaptureEvent, SubjectRef } from "../contracts/event";
import { tableExists } from "../ledger/schema";
import { validateEventOrigin } from "../ledger/event-origin";
import { requireSourceEvents } from "../ledger/source-grants";
import { validatePageCandidate } from "../contracts/page-candidate";
import { pageCandidateProposal } from "./page-candidate";
import { fileProposal, setProposalStatus, StagingError } from "./proposals";
import type { ProposalInput } from "./proposals";
import { sourceTombstoneProposal, SourceTombstoneError } from "../canon/source-tombstone";
import type { SourceTombstoneContext } from "../canon/source-tombstone";
import { encodeSubjectSegment, namespacedSubjectId } from "./subjects";

/**
 * The deterministic floor: claims derivable from an event with no model.
 * Inspection only. Nothing here writes canon, and nothing here is a review
 * queue — the receipted writer acts on the claims later.
 */

/** A source identifier establishes identity, not a personal entity type. */
const ENTITY_CONFIDENCE = 0.5;
/** A verbatim quote of captured text is as certain as the ledger row it cites. */
const CAPTURE_CONFIDENCE = 1;

/**
 * Calibrated capture-note policy. Not a config flag: one named budget the
 * deterministic producer actually enforces.
 */
export const DETERMINISTIC_PRODUCER_BUDGET = {
  maxSubjectsPerEvent: 16,
  maxCaptureNoteChars: 8_000,
} as const;

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
  const subjectRef = namespacedSubjectId(event.connector_id, subject.subject_id);
  return {
    kind: "entity",
    target: subjectRef,
    // Stable per namespaced subject, so a second sighting dedupes onto this
    // candidate instead of forking a second stub page for the same subject.
    body: `Stub entity page for \`${subjectRef}\`.`,
    frontmatter: {
      type: subjectPageType(subject.subject_id),
      title: handle,
      "x-handle": handle,
      "x-subject-id": subject.subject_id,
      "x-connector": event.connector_id,
      ...(subject.display_name === undefined
        ? {}
        : { "x-display-name": subject.display_name }),
    },
    provenance: [event.event_id],
    subjects: [subjectRef],
    producer: "deterministic",
    confidence: ENTITY_CONFIDENCE,
    ...(event.sensitivity_hint === undefined
      ? {}
      : { sensitivity: event.sensitivity_hint }),
    taint: "quoted",
    authority: "connector_evidence",
  };
}

function captureNoteTarget(event: CaptureEvent): string {
  const day = event.occurred_at.slice(0, 10);
  const connector = encodeSubjectSegment(event.connector_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return `captures/${connector}`;
  }
  return `captures/${connector}/${day}`;
}

function captureNoteProposal(event: CaptureEvent): ProposalInput {
  const clipped =
    event.text.length > DETERMINISTIC_PRODUCER_BUDGET.maxCaptureNoteChars
      ? event.text.slice(0, DETERMINISTIC_PRODUCER_BUDGET.maxCaptureNoteChars)
      : event.text;
  const truncated =
    clipped.length < event.text.length
      ? " Quoted text truncated to the capture-note budget."
      : "";
  const header = `Captured from \`${event.connector_id}\` (${event.kind}) at ${event.occurred_at}.${truncated}`;
  const subjects = event.subjects
    .slice(0, DETERMINISTIC_PRODUCER_BUDGET.maxSubjectsPerEvent)
    .map((subject) => namespacedSubjectId(event.connector_id, subject.subject_id));
  return {
    kind: "claim",
    target: captureNoteTarget(event),
    body: `${header}\n\n${blockquote(clipped)}`,
    frontmatter: {
      type: "source",
      title: `Capture from ${event.connector_id} at ${event.occurred_at}`,
      "x-connector": event.connector_id,
      "x-capture-kind": event.kind,
    },
    provenance: [event.event_id],
    subjects,
    producer: "deterministic",
    confidence: CAPTURE_CONFIDENCE,
    ...(event.sensitivity_hint === undefined
      ? {}
      : { sensitivity: event.sensitivity_hint }),
    taint: "quoted",
    authority: "connector_evidence",
  };
}

/** What the trusted host grants the source an event arrived from. */
export interface ProducerGrants {
  /**
   * The emitting connector's `page_candidates` manifest capability. Event
   * metadata is attacker-controlled (AGENTS.md invariant 7), so the authority
   * to turn it into unquoted page prose is bound to the connector the host
   * enrolled, never to the metadata that asks for it.
   */
  page_candidates: boolean;
}

/** Nothing granted: what a caller that names no source policy gets. */
const NO_GRANTS: ProducerGrants = { page_candidates: false };

/**
 * Entity candidates for every distinct subject, plus either the typed page an
 * event proposes through its metadata or, failing that, one source-faithful
 * capture note quoting the event text. A tombstone produces nothing: it
 * withdraws proposals rather than making them.
 */
export function proposalsForEvent(
  event: CaptureEvent,
  grants: ProducerGrants = NO_GRANTS,
): ProposalInput[] {
  if (event.deleted || event.origin === "self") return [];

  const proposals: ProposalInput[] = [];
  const seen = new Set<string>();
  const subjects = event.subjects.slice(
    0,
    DETERMINISTIC_PRODUCER_BUDGET.maxSubjectsPerEvent,
  );
  for (const subject of subjects) {
    const key = namespacedSubjectId(event.connector_id, subject.subject_id);
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push(entityProposal(event, subject));
  }

  const candidate = grants.page_candidates
    ? validatePageCandidate(event.metadata)
    : null;
  if (candidate !== null && candidate.ok) {
    proposals.push(pageCandidateProposal(event, candidate.value));
  } else if (event.text.trim().length > 0) {
    proposals.push(captureNoteProposal(event));
  }
  return proposals;
}

/**
 * A source tombstone cascades to staging: every open proposal citing the event
 * is withdrawn. Claims already written into canon are untouched here —
 * retraction goes through `cascadeTombstone` and the receipted writer.
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
    for (const id of ids) setProposalStatus(db, id, "withdrawn");
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
 * up, pending proposals citing any of them are withdrawn, and each receipted
 * page citing any of them gets a live `deletion` claim for the receipted
 * writer. Requires a database that holds both the ledger and staging schemas.
 */
export function cascadeTombstone(
  db: Database,
  tombstone: CaptureEvent,
  context?: SourceTombstoneContext,
): TombstoneCascade {
  return db.transaction(() => {
    tombstone = validateEventOrigin(db, tombstone);
    if (!tombstone.deleted) throw new StagingError("tombstone: stored event is not deleted");
    // Recording deletion and withdrawing stale pending evidence belong to
    // capture. Any canon control below independently requires derive authority.
    requireSourceEvents(db, [tombstone.event_id], { owner: true, purpose: "capture" });
    const eventRows = db
      .query(
        `SELECT e.event_id FROM events e
          LEFT JOIN source_event_bindings b ON b.event_id=e.event_id
          WHERE e.connector_id = ? AND e.source_record_id = ?
            AND b.source_key IS (SELECT source_key FROM source_event_bindings WHERE event_id=?)`,
      )
      .all(tombstone.connector_id, tombstone.source_record_id, tombstone.event_id) as {
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
        `SELECT DISTINCT r.page_path AS page_path
           FROM canon_receipts r, json_each(r.claim_ids) c,
                proposals p, json_each(p.provenance) j
          WHERE p.proposal_id = c.value
            AND p.status = 'promoted'
            AND p.kind NOT IN ('deletion', 'purge_review')
            AND j.value IN (${placeholders})`,
      )
      .all(...ids) as { page_path: string }[];

    const retractions: string[] = [];
    for (const page of promotedPages) {
      if (context === undefined) throw new SourceTombstoneError("source_tombstone_vault_required");
      const input = sourceTombstoneProposal(db, tombstone, page.page_path, context);
      if (input === null) continue;
      const result = fileProposal(db, input, context);
      if (result.outcome === "stored") {
        retractions.push(result.proposal.proposal_id);
      }
    }

    return { withdrawn, retractions_filed: retractions };
  }).immediate();
}
