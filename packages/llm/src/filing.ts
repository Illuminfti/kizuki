import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CaptureEvent } from "@kizuki/core";
import { fileProposal } from "@kizuki/core/staging";
import type { ProposalInput } from "@kizuki/core/staging";
import { claimsDraft, entityDrafts, summaryDraft, targetRelPath } from "./drafts";
import { validateClaims, validateEntities, validateSummary } from "./output";
import type { OutputResult } from "./output";
import type { ProducerName } from "./prompt";
import type { EnrichmentOutcome } from "./schema";

export function validateOutput(
  producer: ProducerName,
  raw: Record<string, unknown>,
  event: CaptureEvent,
): OutputResult<unknown> {
  if (producer === "summary") return validateSummary(raw);
  if (producer === "entities") return validateEntities(raw);
  return validateClaims(
    raw,
    event.subjects.map((subject) => subject.subject_id),
  );
}

export interface DraftPlan {
  drafts: ProposalInput[];
  skipped_existing: number;
}

/**
 * An entity page the owner already has, or already has a proposal for, does
 * not need a second candidate: a second pending proposal for the same target
 * would only collide at promote time.
 */
export function planEntityDrafts(
  db: Database,
  vaultPath: string,
  drafts: ProposalInput[],
): DraftPlan {
  const claimed = db.query<{ hit: number }, [string]>(
    `SELECT 1 AS hit FROM proposals
      WHERE kind = 'entity' AND target = ? AND status IN ('pending', 'promoted')
      LIMIT 1`,
  );
  const keep: ProposalInput[] = [];
  let skipped = 0;
  for (const draft of drafts) {
    const target = draft.target;
    if (
      typeof target === "string" &&
      (claimed.get(target) !== null ||
        existsSync(join(vaultPath, targetRelPath(target))))
    ) {
      skipped += 1;
      continue;
    }
    keep.push(draft);
  }
  return { drafts: keep, skipped_existing: skipped };
}

export function draftsFor(
  producer: ProducerName,
  event: CaptureEvent,
  model: string,
  value: unknown,
): ProposalInput[] {
  const ctx = { event, model };
  if (producer === "summary") {
    return [summaryDraft(ctx, value as Parameters<typeof summaryDraft>[1])];
  }
  if (producer === "entities") {
    return entityDrafts(ctx, value as Parameters<typeof entityDrafts>[1]);
  }
  return [claimsDraft(ctx, value as Parameters<typeof claimsDraft>[1])];
}

export interface FilingResult {
  outcome: EnrichmentOutcome;
  proposal_ids: string[];
  stored: number;
  duplicates: number;
  suppressed: number;
}

export function fileDrafts(db: Database, drafts: ProposalInput[]): FilingResult {
  const proposalIds: string[] = [];
  let stored = 0;
  let duplicates = 0;
  let suppressed = 0;
  for (const draft of drafts) {
    const filed = fileProposal(db, draft);
    if (filed.outcome === "suppressed") {
      suppressed += 1;
      continue;
    }
    proposalIds.push(filed.proposal.proposal_id);
    if (filed.outcome === "stored") stored += 1;
    else duplicates += 1;
  }
  const outcome: EnrichmentOutcome =
    stored > 0 ? "filed" : suppressed > duplicates ? "suppressed" : "duplicate";
  return { outcome, proposal_ids: proposalIds, stored, duplicates, suppressed };
}
