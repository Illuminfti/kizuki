import type { Database } from "bun:sqlite";
import { assertStoredPageRelPath } from "../canon/paths";
import { requireCanonFiles, snapshotCanonIo, withCanonMutationAsync } from "../canon/io";
import { readOwnedCanonPage } from "../canon/io";
import { VaultMutationError, type VaultMutationScope } from "../vault/mutation-scope";
import { toolAllowed } from "../agents/authorization";
import { compareRfc3339 } from "../agents/time";
import { applyCanonWriteOwned } from "../canon/apply";
import { resolveTarget } from "../canon/arbiter";
import { BudgetExhausted, createBudgetTracker } from "../canon/budget";
import { CanonWriteError } from "../canon/errors";
import type { CanonIo } from "../canon";
import { getCanonReceipt } from "../canon/receipts";
import { getClaim, insertClaim, listClaims, supersedeLiveGroup } from "../claims/store";
import type { Claim, FrontmatterValue, Producer } from "../contracts/proposal";
import { recordNativeCorrection } from "./evidence";
import { requireSourceEvents } from "../ledger/source-grants";
import type { CaptureEventInput, SubjectRef } from "../contracts/event";
import { tableExists } from "../ledger/schema";
import { isRfc3339 } from "../util/time";
import { ulid } from "../util/ulid";
import { unifiedDiff } from "./diff";
import { bumpClaimsEpoch, initClaimsEpoch } from "./epoch";
import { CorrectError } from "./errors";
import { correctionRecoveryPending } from "./recovery";
import { CanonRecoveryError, inspectCanonRecovery } from "../canon/write-intent";
import { hasExactTarget, objectFromStatement, sourceRecordId } from "./parse";
import {
  CORRECTION_MAX_PAGES,
  OWNER_CONNECTOR_ID,
} from "./types";
import type { CorrectInput, CorrectIo, CorrectResult, CorrectTarget } from "./types";

const STATEMENT_MAX = 2000;
const TARGET_REQUIRED_HINT =
  'kizuki tell "…" --claim <id>  (see kizuki doctor).';

function nowOf(io: CorrectIo): string {
  return io.now?.() ?? new Date().toISOString();
}

function mintId(io: CorrectIo): string {
  return io.ids?.() ?? ulid();
}

function canonIo(io: CorrectIo): CanonIo {
  return snapshotCanonIo(io);
}

function snapshotCorrectIo(io: CorrectIo): CorrectIo {
  const canon = snapshotCanonIo(io);
  const { budget, producer, relay_owner_corrections, grant } = io;
  return Object.freeze({
    ...canon,
    ...(budget === undefined ? {} : { budget }),
    ...(producer === undefined ? {} : { producer }),
    ...(relay_owner_corrections === undefined ? {} : { relay_owner_corrections }),
    ...(grant === undefined ? {} : { grant }),
  });
}

interface VaultPageBytes {
  content: string;
  hash: string;
  data: Record<string, unknown>;
}

function activePagePath(relPath: string): string | null {
  if (relPath === "") return null;
  assertStoredPageRelPath(relPath);
  return relPath.startsWith("archive/") ? null : relPath;
}

function readVaultPage(io: CanonIo, relPath: string): VaultPageBytes | null {
  if (activePagePath(relPath) === null) return null;
  const page = readOwnedCanonPage(io, relPath);
  if (page === null) return null;
  return {
    content: page.content,
    hash: page.hash,
    data: page.page.data,
  };
}

interface PageIndexRow {
  page_id: string;
  rel_path: string;
}

function pageIndexById(db: Database, pageId: string): PageIndexRow | null {
  if (!tableExists(db, "page_index")) return null;
  return (
    db
      .query<PageIndexRow, [string]>(
        "SELECT page_id, rel_path FROM page_index WHERE page_id = ?",
      )
      .get(pageId) ?? null
  );
}

function pagesForSubject(db: Database, subjectKey: string): PageIndexRow[] {
  if (!tableExists(db, "page_index")) return [];
  return db
    .query<PageIndexRow, [string]>(
      "SELECT page_id, rel_path FROM page_index WHERE subject_key = ? ORDER BY page_id LIMIT 64",
    )
    .all(subjectKey);
}

function assertStatement(statement: string): void {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new CorrectError("statement_invalid", "statement must be 1..2000 characters");
  }
  if (statement.length > STATEMENT_MAX) {
    throw new CorrectError("statement_invalid", "statement must be 1..2000 characters");
  }
}

function assertScope(scope: CorrectInput["scope"]): void {
  if (scope === undefined) return;
  if (scope.since !== undefined && !isRfc3339(scope.since)) {
    throw new CorrectError("statement_invalid", "scope.since must be RFC3339");
  }
  if (scope.until !== undefined && !isRfc3339(scope.until)) {
    throw new CorrectError("statement_invalid", "scope.until must be RFC3339");
  }
}

function assertGrant(io: CorrectIo): void {
  if (io.grant === undefined) return;
  if (!toolAllowed(io.grant, "correct")) {
    throw new CorrectError("tool_not_granted", "grant.tools does not include correct");
  }
}

function inScope(claim: Claim, scope: CorrectInput["scope"]): boolean {
  if (scope === undefined) return true;
  if (scope.since !== undefined && compareRfc3339(claim.valid_from, "valid_from", scope.since, "since") < 0) {
    return false;
  }
  if (scope.until !== undefined && compareRfc3339(claim.valid_from, "valid_from", scope.until, "until") > 0) {
    return false;
  }
  return true;
}

function portableFrontmatter(live: Claim): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  for (const key of ["type", "title", "x-subject-id"] as const) {
    const value = live.frontmatter[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function pagePathForClaim(db: Database, claim: Claim): string | null {
  if (claim.receipt_id === null) return null;
  if (!tableExists(db, "canon_receipts")) return null;
  const path = (
    db
      .query<{ page_path: string }, [string]>(
        "SELECT page_path FROM canon_receipts WHERE receipt_id = ?",
      )
      .get(claim.receipt_id)?.page_path ?? null
  );
  return path === null ? null : activePagePath(path);
}

function findOwnerEvent(db: Database, sourceId: string): string | null {
  if (!tableExists(db, "events")) return null;
  return (
    db
      .query<{ event_id: string }, [string, string]>(
        `SELECT event_id FROM events
          WHERE connector_id = ? AND source_record_id = ?
          ORDER BY accepted_at, event_id LIMIT 1`,
      )
      .get(OWNER_CONNECTOR_ID, sourceId)?.event_id ?? null
  );
}

function ownerSubjects(target: CorrectTarget | undefined, live: Claim): SubjectRef[] {
  const subject = target?.subject ?? live.subject;
  if (subject === null || subject === undefined || subject.length === 0) return [];
  return [{ subject_id: subject, role: "about" }];
}

function loadExactGroup(io: CorrectIo, target: CorrectTarget, scope: CorrectInput["scope"]): Claim[] {
  if (typeof target.claim_id === "string" && target.claim_id.length > 0) {
    const named = getClaim(io.db, target.claim_id);
    if (named === null) {
      throw new CorrectError("claim_unknown", "target claim is not in the claims table");
    }
    if (named.status !== "live") {
      throw new CorrectError("claim_not_live", `target claim is ${named.status}`);
    }
    if (named.claim_key === null) {
      return inScope(named, scope) ? [named] : [];
    }
    return listClaims(io.db, { status: "live", claim_key: named.claim_key }).filter((claim) =>
      inScope(claim, scope),
    );
  }
  if (typeof target.claim_key === "string" && target.claim_key.length > 0) {
    const group = listClaims(io.db, { status: "live", claim_key: target.claim_key }).filter((claim) =>
      inScope(claim, scope),
    );
    if (group.length === 0) {
      throw new CorrectError("claim_unknown", "target claim_key has no live claims");
    }
    return group;
  }
  throw new CorrectError("target_required", TARGET_REQUIRED_HINT);
}

function seedClaim(group: Claim[], target: CorrectTarget): Claim {
  if (typeof target.claim_id === "string" && target.claim_id.length > 0) {
    const named = group.find((claim) => claim.claim_id === target.claim_id);
    if (named !== undefined) return named;
  }
  const first = group[0];
  if (first === undefined) {
    throw new CorrectError("claim_unknown", "target claim_key has no live claims");
  }
  return first;
}

function recordedOwnerEvent(db: Database, sourceId: string): string | null {
  if (!tableExists(db, "events") || !tableExists(db, "native_owner_evidence")) return null;
  return (
    db
      .query<{ event_id: string }, [string, string]>(
        `SELECT e.event_id FROM events e
           JOIN native_owner_evidence n ON n.event_id = e.event_id
          WHERE e.connector_id = ? AND e.source_record_id = ?
          ORDER BY e.accepted_at, e.event_id
          LIMIT 1`,
      )
      .get(OWNER_CONNECTOR_ID, sourceId)?.event_id ?? null
  );
}

/** The claim this owner event created. Later winners may inherit the event further in provenance. */
function recordedCorrection(db: Database, eventId: string): Claim | null {
  if (!tableExists(db, "claims")) return null;
  const row = db
    .query<{ claim_id: string }, [string]>(
      `SELECT claim_id FROM claims
        WHERE json_extract(provenance, '$[0]') = ?
        ORDER BY created_at, claim_id
        LIMIT 1`,
    )
    .get(eventId);
  return row === null ? null : getClaim(db, row.claim_id);
}

function reconstruct(
  io: CorrectIo,
  eventId: string,
  winner: Claim,
): CorrectResult {
  const losers = io.db
    .query<{ loser: string }, [string]>(
      "SELECT loser FROM claim_supersessions WHERE winner = ? ORDER BY at, loser",
    )
    .all(winner.claim_id);
  const superseded = losers.flatMap((row) => {
    const claim = getClaim(io.db, row.loser);
    if (claim === null || claim.claim_key === null) return [];
    return [
      {
        claim_id: claim.claim_id,
        claim_key: claim.claim_key,
        was: claim.object ?? claim.body,
        page_path: pagePathForClaim(io.db, claim),
      },
    ];
  });
  const receipts = winner.receipt_id === null ? [] : [getCanonReceipt(io.db, winner.receipt_id)].filter(
    (row) => row !== null,
  );
  const rewritten = receipts.flatMap((receipt) => {
    if (activePagePath(receipt.page_path) === null) return [];
    const page = readVaultPage(io, receipt.page_path);
    return [{
      page_path: receipt.page_path,
      before_hash: receipt.before_hash ?? "",
      after_hash: receipt.after_hash,
      receipt_id: receipt.receipt_id,
      diff: page === null ? "" : unifiedDiff("", page.content, receipt.page_path),
    }];
  });
  const pending = correctionRecoveryPending(io.db, winner.claim_id);
  const knownPaths = [...new Set(superseded.flatMap(row => row.page_path === null ? [] : [row.page_path]))].slice(0, CORRECTION_MAX_PAGES);
  for (const path of knownPaths) for (const item of correctionRecoveryPending(io.db, winner.claim_id, path)) {
    if (!pending.some(prior => prior.receipt_id === item.receipt_id)) pending.push(item);
  }
  return {
    ...(pending.length === 0 ? {} : { recovery_pending: pending }),
    receipt_id: winner.receipt_id,
    event_id: eventId,
    claim_ids: [winner.claim_id],
    superseded,
    rewritten,
    ambiguous: [],
    answer: formatAnswer(winner, superseded, rewritten, rewritten.length === 0 ? null : winner.receipt_id, 0, pending.length === 0 ? undefined : pending),
  };
}

function replayRecordedCorrection(io: CorrectIo, input: CorrectInput): CorrectResult | null {
  const eventId = recordedOwnerEvent(io.db, sourceRecordId(input.statement, input.target));
  if (eventId === null) return null;
  const prior = recordedCorrection(io.db, eventId);
  if (prior === null) return null;
  if (prior.status === "skipped") {
    throw new CorrectError("below_authority", "correction was below the live claim's authority");
  }
  requireSourceEvents(io.db, prior.provenance, {
    owner: !(io.producer ?? "owner").startsWith("agent:"),
    purpose: "correction",
  });
  const replay = reconstruct(io, eventId, prior);
  const recovery = inspectCanonRecovery(io.db);
  if (
    (recovery.pending || recovery.projection_pending > 0) &&
    replay.recovery_pending === undefined
  ) {
    // A held write owned by another correction must still make this replay
    // visibly incomplete, without attributing that receipt or page to it.
    return { ...replay, recovery_pending: [] };
  }
  return replay;
}

function formatAnswer(
  winner: Claim,
  superseded: CorrectResult["superseded"],
  rewritten: CorrectResult["rewritten"],
  receiptId: string | null,
  remainder: number,
  pending?: CorrectResult['recovery_pending'],
): string {
  const was = superseded[0]?.was;
  const now = winner.object ?? winner.body;
  const subject = winner.subject ?? "subject";
  const predicate = winner.predicate ?? "claim";
  const head =
    was === undefined
      ? `Corrected: ${subject} ${predicate} is ${now}.`
      : `Corrected: ${subject} ${predicate} is ${now} (was: ${was}).`;
  const pages = rewritten.map((row) => row.page_path).join(", ");
  const undoIds = [
    ...new Set(
      [receiptId, ...rewritten.map((row) => row.receipt_id)].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
  const undo =
    undoIds.length === 0
      ? ""
      : `\nUndo: ${undoIds.map((id) => `kizuki undo ${id}`).join("; ")}`;
  const extra =
    remainder > 0
      ? `\n${remainder} more page(s) not rewritten in this pass.`
      : "";
  return [
    head,
    `Superseded ${superseded.length} claim${superseded.length === 1 ? "" : "s"}.`,
    pages.length > 0 ? `Rewrote ${pages}.` : pending !== undefined ? "Canon completion is unconfirmed." : "No canon pages rewritten.",
  ]
    .join("\n")
    .concat(extra, pending !== undefined ? "\nCanon recovery is pending. Run kizuki recover --json; unknown external operations require inspection before another change." : "", undo);
}

function acceptOwnerEvent(
  io: CorrectIo,
  input: CorrectInput,
  live: Claim,
  at: string,
): { event_id: string; duplicate: boolean } {
  const sourceId = sourceRecordId(input.statement, input.target);
  const existing = findOwnerEvent(io.db, sourceId);
  const event: CaptureEventInput = {
    schema: "kizuki.event/v1",
    connector_id: OWNER_CONNECTOR_ID,
    source_record_id: sourceId,
    kind: "note",
    occurred_at: at,
    observed_at: at,
    text: input.statement,
    subjects: ownerSubjects(input.target, live),
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {
      taint: "owner",
      origin: "external",
      target: input.target ?? {},
    },
  };
  if (input.dry_run === true) {
    return { event_id: existing ?? mintId(io), duplicate: existing !== null };
  }
  try { return recordNativeCorrection(io.db, event, sourceId); }
  catch { throw new CorrectError("ledger_rejected", "owner correction conflicts with existing evidence or could not be recorded"); }
}

async function insertCorrection(
  io: CorrectIo,
  input: CorrectInput,
  live: Claim,
  eventId: string,
  at: string,
  provenance: readonly string[],
): Promise<Claim> {
  const parsed = objectFromStatement(input.statement, live);
  const producer: Producer = io.producer ?? "owner";
  const relay = io.relay_owner_corrections !== false;
  const intent = relay ? ("correct" as const) : ("propose" as const);
  const result = await insertClaim(
    { db: io.db, now: () => at, ...(io.retrieval === undefined ? {} : { retrieval: io.retrieval }) },
    {
      kind: live.kind === "entity" ? "entity" : "claim",
      target: live.target,
      subject: live.subject,
      predicate: live.predicate,
      object: parsed.object,
      polarity: parsed.polarity,
      body: input.statement,
      frontmatter: portableFrontmatter(live),
      provenance: [...new Set([eventId, ...provenance])],
      subjects: live.subject !== null ? [live.subject] : [],
      producer,
      confidence: 1,
      sensitivity: live.sensitivity,
      taint: "clean",
      valid_from: at,
      intent,
      events: [
        {
          event_id: eventId,
          connector_id: OWNER_CONNECTOR_ID,
          taint: "owner",
          origin: "external",
          text: input.statement,
        },
      ],
    },
  );
  if (
    result.outcome === "skipped" ||
    (result.outcome === "duplicate" && result.claim.status === "skipped")
  ) {
    throw new CorrectError("below_authority", "correction was below the live claim's authority");
  }
  if (result.outcome === "duplicate") return result.claim;
  if (result.outcome === "contested") return result.incoming;
  return result.claim;
}

interface AffectedPage {
  page_id: string;
  rel_path: string;
  relevance: number;
}

function affectedPages(io: CorrectIo, group: Claim[], winner: Claim): AffectedPage[] {
  const seen = new Map<string, AffectedPage>();
  const add = (pageId: string, relPath: string, relevance: number): void => {
    if (activePagePath(relPath) === null) return;
    const current = seen.get(relPath);
    if (current === undefined || relevance > current.relevance) {
      seen.set(relPath, { page_id: pageId, rel_path: relPath, relevance });
    }
  };

  const keys = new Set<string>();
  if (winner.claim_key !== null) keys.add(winner.claim_key);
  for (const claim of group) {
    if (claim.claim_key !== null) keys.add(claim.claim_key);
    const path = pagePathForClaim(io.db, claim);
    if (path !== null) {
      const page = readVaultPage(io, path);
      const id = page?.data["id"];
      if (typeof id === "string") add(id, path, 1);
    }
  }

  if (tableExists(io.db, "claim_bindings")) {
    for (const key of keys) {
      const rows = io.db
        .query<{ page_id: string }, [string]>(
          "SELECT page_id FROM claim_bindings WHERE claim_key = ? ORDER BY bound_at DESC, page_id",
        )
        .all(key);
      for (const row of rows) {
        const indexed = pageIndexById(io.db, row.page_id);
        if (indexed !== null) add(indexed.page_id, indexed.rel_path, 1);
      }
    }
  }

  const provenance = new Set(group.flatMap((claim) => claim.provenance));
  provenance.add(winner.provenance[0] ?? "");
  if (tableExists(io.db, "canon_receipts")) {
    const rows = io.db
      .query<{ page_path: string; provenance: string }, []>(
        "SELECT page_path, provenance FROM canon_receipts",
      )
      .all();
    for (const row of rows) {
      let sources: unknown;
      try {
        sources = JSON.parse(row.provenance);
      } catch {
        continue;
      }
      if (!Array.isArray(sources) || !sources.some((id) => typeof id === "string" && provenance.has(id))) {
        continue;
      }
      const page = readVaultPage(io, row.page_path);
      const id = page?.data["id"];
      if (typeof id === "string") add(id, row.page_path, 0.8);
    }
  }

  if (winner.subject !== null) {
    for (const entry of pagesForSubject(io.db, winner.subject)) {
      add(entry.page_id, entry.rel_path, 0.6);
    }
  }

  if (typeof winner.target === "string" && winner.target.length > 0) {
    const byId = pageIndexById(io.db, winner.target);
    if (byId !== null) add(byId.page_id, byId.rel_path, 0.9);
  }

  return [...seen.values()].sort((left, right) => {
    if (left.relevance !== right.relevance) return right.relevance - left.relevance;
    return left.rel_path < right.rel_path ? -1 : left.rel_path > right.rel_path ? 1 : 0;
  });
}


/**
 * RFC 0002 §6. Native targeted correction used by `kizuki tell`.
 * Shared evidence recording also serves MCP correction.
 * `--claim` / `claim_key` resolve without a model.
 */
export async function correct(io: CorrectIo, input: CorrectInput): Promise<CorrectResult> {
  io = snapshotCorrectIo(io);
  const { statement, target, scope, dry_run } = input;
  input = Object.freeze({ statement,
    ...(target === undefined ? {} : { target: Object.freeze({ ...target }) }),
    ...(scope === undefined ? {} : { scope: Object.freeze({ ...scope }) }),
    ...(dry_run === undefined ? {} : { dry_run }),
  });
  try {
    return await withCanonMutationAsync(io, (owner, owned) => correctOwned(owner, owned, input));
  } catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") {
      throw new CorrectError("writer_busy", "canon writer is busy; retry the correction");
    }
    throw error;
  }
}

async function correctOwned(scope: VaultMutationScope, io: CorrectIo, input: CorrectInput): Promise<CorrectResult> {
  requireCanonFiles(scope, io);
  assertStatement(input.statement);
  assertScope(input.scope);
  assertGrant(io);
  initClaimsEpoch(io.db);

  if (!hasExactTarget(input.target)) {
    throw new CorrectError("target_required", TARGET_REQUIRED_HINT);
  }

  if (input.dry_run !== true) {
    const recorded = replayRecordedCorrection(io, input);
    if (recorded !== null) return recorded;
  }

  const group = loadExactGroup(io, input.target as CorrectTarget, input.scope);
  if (group.length === 0) {
    throw new CorrectError("claim_unknown", "no live claims matched the target and scope");
  }
  const provenance = [...new Set(group.flatMap(claim => claim.provenance))];
  requireSourceEvents(io.db, provenance, { owner: !(io.producer ?? "owner").startsWith("agent:"), purpose: "correction" });
  const seed = seedClaim(group, input.target as CorrectTarget);
  const at = nowOf(io);
  const accepted = acceptOwnerEvent(io, input, seed, at);

  if (input.dry_run === true) {
    const parsed = objectFromStatement(input.statement, seed);
    const superseded = group.map((claim) => ({
      claim_id: claim.claim_id,
      claim_key: claim.claim_key ?? "",
      was: claim.object ?? claim.body,
      page_path: pagePathForClaim(io.db, claim),
    }));
    const previewPages = affectedPages(io, group, seed).slice(0, CORRECTION_MAX_PAGES);
    const rewritten = previewPages.flatMap((page) => {
      const existing = readVaultPage(io, page.rel_path);
      if (existing === null) return [];
      const after = existing.content.replace(seed.body, input.statement);
      return [
        {
          page_path: page.rel_path,
          before_hash: existing.hash,
          after_hash: new Bun.CryptoHasher("sha256").update(after).digest("hex"),
          receipt_id: null,
          diff: unifiedDiff(existing.content, after, page.rel_path),
        },
      ];
    });
    return {
      receipt_id: null,
      event_id: accepted.event_id,
      claim_ids: [],
      superseded,
      rewritten,
      ambiguous: [],
      answer: formatAnswer(
        { ...seed, object: parsed.object, body: input.statement },
        superseded,
        rewritten,
        null,
        Math.max(0, affectedPages(io, group, seed).length - CORRECTION_MAX_PAGES),
      ),
    };
  }

  const winner = await insertCorrection(io, input, seed, accepted.event_id, at, provenance);
  supersedeLiveGroup(io.db, winner, at);
  const superseded = io.db
    .query<{ loser: string }, [string]>(
      "SELECT loser FROM claim_supersessions WHERE winner = ? ORDER BY at, loser",
    )
    .all(winner.claim_id)
    .flatMap((row) => {
      const claim = getClaim(io.db, row.loser);
      if (claim === null) return [];
      return [
        {
          claim_id: claim.claim_id,
          claim_key: claim.claim_key ?? winner.claim_key ?? "",
          was: claim.object ?? claim.body,
          page_path: pagePathForClaim(io.db, claim),
        },
      ];
    });

  const pages = affectedPages(io, group, winner);
  const remainder = Math.max(0, pages.length - CORRECTION_MAX_PAGES);
  const chosen = pages.slice(0, CORRECTION_MAX_PAGES);
  const budget = io.budget ?? createBudgetTracker({ canon_writes_per_run: CORRECTION_MAX_PAGES });
  const canon = canonIo(io);
  const rewritten: CorrectResult["rewritten"] = [];
  const claimIds = [winner.claim_id];
  let recoveryPending: CorrectResult["recovery_pending"];
  let receiptId: string | null = null;

  for (const [index, page] of chosen.entries()) {
    const held = correctionRecoveryPending(io.db, winner.claim_id, page.rel_path);
    if (held.length > 0) {
      recoveryPending = [...(recoveryPending ?? []), ...held];
      continue;
    }
    const existing = readVaultPage(io, page.rel_path);
    if (existing === null) continue;
    const before = existing.content;
    let claim = winner;
    if (index > 0) {
      const extra = await insertClaim(
        { db: io.db, now: () => at },
        {
          kind: "claim",
          target: page.page_id,
          subject: winner.subject,
          predicate: null,
          object: null,
          body: input.statement,
          frontmatter: portableFrontmatter(winner),
          provenance: winner.provenance,
          subjects: winner.subjects,
          producer: winner.producer,
          confidence: 1,
          sensitivity: winner.sensitivity,
          taint: "clean",
          intent: io.relay_owner_corrections === false ? "propose" : "correct",
          events: [
            {
              event_id: accepted.event_id,
              connector_id: OWNER_CONNECTOR_ID,
              taint: "owner",
              origin: "external",
              text: input.statement,
            },
          ],
        },
      );
      if (extra.outcome === "stored" || extra.outcome === "contested") {
        claim = extra.outcome === "stored" ? extra.claim : extra.incoming;
        claimIds.push(claim.claim_id);
      } else {
        continue;
      }
    }
    const stored = getClaim(io.db, claim.claim_id);
    if (stored === null || stored.receipt_id !== null) continue;
    const decision = resolveTarget(canon, stored);
    if (decision.action === "skip") continue;
    const writeDecision =
      decision.action === "create"
        ? decision
        : {
            action: "supersede" as const,
            page_id: page.page_id,
            rel_path: page.rel_path,
            superseded: superseded.map((row) => row.claim_id),
          };
    let receipt: ReturnType<typeof applyCanonWriteOwned>;
    try {
      receipt = applyCanonWriteOwned(scope, canon, stored, writeDecision, {
        writer: "correction",
        budget,
      });
    } catch (error) {
      const pending = correctionRecoveryPending(io.db, stored.claim_id, page.rel_path);
      if (pending.length > 0 || error instanceof CanonRecoveryError) { recoveryPending = pending; break; }
      if (error instanceof BudgetExhausted) {
        throw new CorrectError("budget_exhausted", error.stopped, { cause: error });
      }
      if (error instanceof CanonWriteError) {
        continue;
      }
      throw error;
    }
    if (receiptId === null) receiptId = receipt.receipt_id;
    const pending = correctionRecoveryPending(io.db, stored.claim_id, receipt.page_path);
    if (pending.length > 0) recoveryPending = [...(recoveryPending ?? []), ...pending];
    const after = readVaultPage(io, receipt.page_path);
    rewritten.push({
      page_path: receipt.page_path,
      before_hash: receipt.before_hash ?? "",
      after_hash: receipt.after_hash,
      receipt_id: receipt.receipt_id,
      diff: unifiedDiff(before, after?.content ?? before, receipt.page_path),
    });
  }

  bumpClaimsEpoch(io.db);
  // insertClaim already owns the durable, source-authorized retrieval update.
  io.db.query("UPDATE native_owner_evidence SET filing_state='filed' WHERE event_id=?").run(accepted.event_id);

  return {
    receipt_id: receiptId,
    event_id: accepted.event_id,
    claim_ids: claimIds,
    superseded,
    rewritten,
    ambiguous: [],
    ...(recoveryPending === undefined ? {} : { recovery_pending: recoveryPending }),
    answer: formatAnswer(winner, superseded, rewritten, receiptId, remainder, recoveryPending),
  };
}
