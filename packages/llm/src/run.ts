import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SENSITIVITY_ORDER, isRfc3339, ulid } from "@kizuki/core";
import type { CaptureEvent } from "@kizuki/core";
import { fileProposal, initStaging } from "@kizuki/core/staging";
import type { ProposalInput } from "@kizuki/core/staging";
import { ChatClient } from "./client";
import type { Clock } from "./client";
import { readLlmConfig, endpointHost } from "./config";
import type { LlmConfig } from "./config";
import { LlmError } from "./errors";
import type { LlmErrorCode } from "./errors";
import {
  claimsDraft,
  entityDrafts,
  summaryDraft,
  targetRelPath,
} from "./drafts";
import {
  parseModelJson,
  validateClaims,
  validateEntities,
  validateSummary,
} from "./output";
import type { OutputResult } from "./output";
import { PRODUCERS, PROMPT_VERSION, systemPrompt, wrapEvent } from "./prompt";
import type { ProducerName } from "./prompt";
import {
  completedProducers,
  initLlm,
  insertRun,
  recordEnrichment,
  sweepOrphans,
} from "./schema";
import type { EnrichmentOutcome, LlmRun, StopReason } from "./schema";
import { CANDIDATE_PAGE, selectCandidates } from "./select";
import type { CandidateCursor } from "./select";
import { resolveApiKey } from "./secrets";
import type { ChatTransport } from "./transport";

export interface EnrichOptions {
  producers?: ProducerName[];
  limit?: number;
  since?: string;
  connector_id?: string;
  event_id?: string;
  dry_run?: boolean;
  transport?: ChatTransport;
  clock?: Clock;
  env?: Record<string, string | undefined>;
}

export interface EnrichCounts {
  considered: number;
  sent: number;
  would_send: number;
  skipped_unlabeled: number;
  skipped_ceiling: number;
  skipped_done: number;
  skipped_short: number;
  skipped_existing: number;
  requests: number;
  input_chars: number;
  output_chars: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  proposals_filed: number;
  duplicates: number;
  suppressed: number;
  rejected_outputs: number;
  empty_outputs: number;
  errors: number;
  orphans_swept: number;
}

export interface RequestError {
  event_id: string;
  producer: ProducerName;
  code: LlmErrorCode;
  status: number | null;
}

export interface EnrichReceipt {
  status: "unconfigured" | "dry_run" | "ran";
  run: LlmRun | null;
  counts: EnrichCounts;
  request_errors: RequestError[];
}

/** Enough text to be worth a request at all. */
const MIN_EVENT_CHARS = 20;
const MAX_SCAN = 50_000;
const CONSECUTIVE_ERROR_LIMIT = 3;

function zeroCounts(): EnrichCounts {
  return {
    considered: 0,
    sent: 0,
    would_send: 0,
    skipped_unlabeled: 0,
    skipped_ceiling: 0,
    skipped_done: 0,
    skipped_short: 0,
    skipped_existing: 0,
    requests: 0,
    input_chars: 0,
    output_chars: 0,
    prompt_tokens: null,
    completion_tokens: null,
    proposals_filed: 0,
    duplicates: 0,
    suppressed: 0,
    rejected_outputs: 0,
    empty_outputs: 0,
    errors: 0,
    orphans_swept: 0,
  };
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

function requestedProducers(opts: EnrichOptions): ProducerName[] {
  const chosen = opts.producers;
  if (chosen === undefined) return [...PRODUCERS];
  return PRODUCERS.filter((producer) => chosen.includes(producer));
}

function overCeiling(event: CaptureEvent, config: LlmConfig): boolean {
  const hint = event.sensitivity_hint;
  return (
    hint !== undefined &&
    SENSITIVITY_ORDER[hint] > SENSITIVITY_ORDER[config.sensitivity_ceiling]
  );
}

function validateOutput(
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

interface DraftPlan {
  drafts: ProposalInput[];
  skipped_existing: number;
}

/**
 * An entity page the owner already has, or already has a proposal for, does
 * not need a second candidate: a second pending proposal for the same target
 * would only collide at promote time.
 */
function planEntityDrafts(
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

function draftsFor(
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

interface FilingResult {
  outcome: EnrichmentOutcome;
  proposal_ids: string[];
  stored: number;
  duplicates: number;
  suppressed: number;
}

function fileDrafts(db: Database, drafts: ProposalInput[]): FilingResult {
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

/**
 * The owner-invoked enrichment pass. Nothing here runs as a side effect of
 * import or sync: a request leaves the machine only because the owner asked
 * for one, under a configuration they wrote, within a budget they set.
 */
export async function runEnrichment(
  db: Database,
  vaultPath: string,
  opts: EnrichOptions = {},
): Promise<EnrichReceipt> {
  const counts = zeroCounts();
  const requestErrors: RequestError[] = [];

  const config = readLlmConfig(vaultPath);
  if (config === null) {
    return { status: "unconfigured", run: null, counts, request_errors: [] };
  }
  if (opts.since !== undefined && !isRfc3339(opts.since)) {
    throw new LlmError("bad_value", "since: must be an RFC3339 timestamp");
  }

  // Fail closed on credentials before anything is selected, sent or written.
  const apiKey =
    config.api_key_ref === null
      ? null
      : resolveApiKey(config.api_key_ref, opts.env ?? process.env);

  const producers = requestedProducers(opts);
  const dryRun = opts.dry_run === true;
  const limit =
    opts.limit ??
    Math.max(
      1,
      Math.floor(config.max_requests / Math.max(1, producers.length)),
    );

  if (!dryRun) {
    initStaging(db);
    initLlm(db);
    counts.orphans_swept = sweepOrphans(db);
  }
  const canReadDone = dryRun ? tableExists(db, "llm_enrichments") : true;

  const client = new ChatClient({
    config,
    api_key: apiKey,
    ...(opts.transport === undefined ? {} : { transport: opts.transport }),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  });

  const startedAt = new Date().toISOString();
  const runId = ulid();
  const filter = {
    ...(opts.event_id === undefined ? {} : { event_id: opts.event_id }),
    ...(opts.connector_id === undefined
      ? {}
      : { connector_id: opts.connector_id }),
    ...(opts.since === undefined ? {} : { since: opts.since }),
  };

  let stopped: StopReason = "complete";
  let consecutiveErrors = 0;
  let cursor: CandidateCursor | null = null;
  let sentEvents = 0;

  scan: while (counts.considered < MAX_SCAN) {
    const page = selectCandidates(db, cursor, filter);
    if (page.length === 0) break;

    for (const candidate of page) {
      if (counts.considered >= MAX_SCAN) break scan;
      counts.considered += 1;
      cursor = {
        accepted_at: candidate.accepted_at,
        event_id: candidate.event.event_id,
      };
      const event = candidate.event;

      const done = canReadDone
        ? completedProducers(db, event.event_id, PROMPT_VERSION, config.model)
        : new Set<ProducerName>();
      const pending = producers.filter((producer) => !done.has(producer));
      counts.skipped_done += producers.length - pending.length;
      if (pending.length === 0) continue;

      if (event.sensitivity_hint === undefined && config.unlabeled === "skip") {
        counts.skipped_unlabeled += 1;
        continue;
      }
      if (overCeiling(event, config)) {
        counts.skipped_ceiling += 1;
        continue;
      }
      const points = Array.from(event.text).length;
      if (points < MIN_EVENT_CHARS) {
        counts.skipped_short += 1;
        continue;
      }

      let usedEvent = false;
      for (const producer of pending) {
        if (producer === "summary" && points < config.summary_min_chars) {
          counts.skipped_short += 1;
          continue;
        }
        const wrapped = wrapEvent(event, producer, config.max_event_chars);
        // The event counts as sent the moment its first request is built, so
        // a run that stops mid-event still reports what it spent.
        if (!usedEvent) {
          usedEvent = true;
          if (dryRun) counts.would_send += 1;
          else {
            counts.sent += 1;
            sentEvents += 1;
          }
        }

        if (dryRun) {
          counts.requests += 1;
          counts.input_chars += wrapped.chars;
          continue;
        }

        const outcome = await client.complete(
          systemPrompt(producer),
          wrapped.user,
        );
        if (!outcome.ok) {
          if (outcome.error.code === "budget_exhausted") {
            stopped = "budget";
            break scan;
          }
          counts.errors += 1;
          consecutiveErrors += 1;
          requestErrors.push({
            event_id: event.event_id,
            producer,
            code: outcome.error.code,
            status: outcome.error.status,
          });
          recordEnrichment(db, {
            event_id: event.event_id,
            producer,
            prompt_version: PROMPT_VERSION,
            model: config.model,
            run_id: runId,
            input_hash: wrapped.input_hash,
            outcome: "error",
            proposal_ids: [],
            error_code: outcome.error.code,
            at: new Date().toISOString(),
          });
          if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
            stopped = "consecutive_errors";
            break scan;
          }
          continue;
        }

        consecutiveErrors = 0;
        const parsed = parseModelJson(outcome.content);
        const validated =
          parsed === undefined
            ? ({ ok: false, reason: "not_json" } as OutputResult<unknown>)
            : validateOutput(producer, parsed, event);

        let record: EnrichmentOutcome;
        let proposalIds: string[] = [];
        if (!validated.ok) {
          record = validated.reason === "empty" ? "empty" : "rejected_output";
          if (record === "empty") counts.empty_outputs += 1;
          else counts.rejected_outputs += 1;
        } else {
          const built = draftsFor(
            producer,
            event,
            config.model,
            validated.value,
          );
          const planned =
            producer === "entities"
              ? planEntityDrafts(db, vaultPath, built)
              : { drafts: built, skipped_existing: 0 };
          counts.skipped_existing += planned.skipped_existing;
          const filed = db.transaction(() => fileDrafts(db, planned.drafts))();
          counts.proposals_filed += filed.stored;
          counts.duplicates += filed.duplicates;
          counts.suppressed += filed.suppressed;
          record = filed.outcome;
          proposalIds = filed.proposal_ids;
        }

        recordEnrichment(db, {
          event_id: event.event_id,
          producer,
          prompt_version: PROMPT_VERSION,
          model: config.model,
          run_id: runId,
          input_hash: wrapped.input_hash,
          outcome: record,
          proposal_ids: proposalIds,
          error_code: null,
          at: new Date().toISOString(),
        });
      }

      if (usedEvent && !dryRun && sentEvents >= limit) break scan;
    }
    if (page.length < CANDIDATE_PAGE) break;
  }

  if (!dryRun) {
    counts.requests = client.counters.requests;
    counts.input_chars = client.counters.input_chars;
    counts.output_chars = client.counters.output_chars;
    counts.prompt_tokens = client.counters.prompt_tokens;
    counts.completion_tokens = client.counters.completion_tokens;
  }

  if (dryRun) {
    return {
      status: "dry_run",
      run: null,
      counts,
      request_errors: requestErrors,
    };
  }

  const run: LlmRun = {
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    endpoint_host: endpointHost(config.base_url),
    model: config.model,
    prompt_version: PROMPT_VERSION,
    producers,
    considered: counts.considered,
    sent: counts.sent,
    skipped_unlabeled: counts.skipped_unlabeled,
    skipped_ceiling: counts.skipped_ceiling,
    skipped_done: counts.skipped_done,
    skipped_short: counts.skipped_short,
    skipped_existing: counts.skipped_existing,
    requests: counts.requests,
    input_chars: counts.input_chars,
    output_chars: counts.output_chars,
    prompt_tokens: counts.prompt_tokens,
    completion_tokens: counts.completion_tokens,
    proposals_filed: counts.proposals_filed,
    duplicates: counts.duplicates,
    suppressed: counts.suppressed,
    rejected_outputs: counts.rejected_outputs,
    empty_outputs: counts.empty_outputs,
    errors: counts.errors,
    orphans_swept: counts.orphans_swept,
    stopped,
  };
  insertRun(db, run);
  return { status: "ran", run, counts, request_errors: requestErrors };
}
