import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolAllowed } from "../agents/authorization";
import { applyCanonWrite } from "../canon/apply";
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
import { parseFrontmatter } from "../vault/frontmatter";
import { unifiedDiff } from "./diff";
import { bumpClaimsEpoch, initClaimsEpoch } from "./epoch";
import { CorrectError } from "./errors";
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
  return {
    db: io.db,
    vault_path: io.vault_path,
    ...(io.now === undefined ? {} : { now: io.now }),
    ...(io.ids === undefined ? {} : { ids: io.ids }),
    ...(io.retrieval === undefined ? {} : { retrieval: io.retrieval }),
    ...(io.retrieval_store === undefined ? {} : { retrieval_store: io.retrieval_store }),
  };
}

interface VaultPageBytes {
  content: string;
  hash: string;
  data: Record<string, unknown>;
}

function readVaultPage(vaultPath: string, relPath: string): VaultPageBytes | null {
  const path = join(vaultPath, relPath);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return {
    content,
    hash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    data: parseFrontmatter(content).data,
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
  if (scope.since !== undefined && claim.valid_from < scope.since) return false;
  if (scope.until !== undefined && claim.valid_from > scope.until) return false;
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
  return (
    db
      .query<{ page_path: string }, [string]>(
        "SELECT page_path FROM canon_receipts WHERE receipt_id = ?",
      )
      .get(claim.receipt_id)?.page_path ?? null
  );
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
    if (named.claim_key === null) {
      if (named.status !== "live") {
        throw new CorrectError("claim_not_live", `target claim is ${named.status}`);
      }
      return inScope(named, scope) ? [named] : [];
    }
    const group = listClaims(io.db, { status: "live", claim_key: named.claim_key }).filter((claim) =>
      inScope(claim, scope),
    );
    if (group.length > 0) return group;
    if (named.status !== "live") {
      throw new CorrectError("claim_not_live", `target claim is ${named.status}`);
    }
    return [];
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

function existingCorrection(db: Database, eventId: string): Claim | null {
  const live = listClaims(db, { status: "live", limit: 500 }).find((claim) =>
    claim.provenance.includes(eventId),
  );
  if (live !== undefined) return live;
  return (
    listClaims(db, { limit: 500 }).find((claim) => claim.provenance.includes(eventId)) ?? null
  );
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
  const rewritten = receipts.map((receipt) => {
    const page = readVaultPage(io.vault_path, receipt.page_path);
    return {
      page_path: receipt.page_path,
      before_hash: receipt.before_hash ?? "",
      after_hash: receipt.after_hash,
      receipt_id: receipt.receipt_id,
      diff: page === null ? "" : unifiedDiff("", page.content, receipt.page_path),
    };
  });
  return {
    receipt_id: winner.receipt_id,
    event_id: eventId,
    claim_ids: [winner.claim_id],
    superseded,
    rewritten,
    ambiguous: [],
    answer: formatAnswer(winner, superseded, rewritten, winner.receipt_id, 0),
  };
}

function formatAnswer(
  winner: Claim,
  superseded: CorrectResult["superseded"],
  rewritten: CorrectResult["rewritten"],
  receiptId: string | null,
  remainder: number,
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
    pages.length > 0 ? `Rewrote ${pages}.` : "No canon pages rewritten.",
  ]
    .join("\n")
    .concat(extra, undo);
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
  if (result.outcome === "skipped") {
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
      const page = readVaultPage(io.vault_path, path);
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
      const page = readVaultPage(io.vault_path, row.page_path);
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
  assertStatement(input.statement);
  assertScope(input.scope);
  assertGrant(io);
  initClaimsEpoch(io.db);

  if (!hasExactTarget(input.target)) {
    throw new CorrectError("target_required", TARGET_REQUIRED_HINT);
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

  if (input.dry_run !== true && accepted.duplicate) {
    const prior = existingCorrection(io.db, accepted.event_id);
    if (prior !== null && prior.receipt_id !== null) {
      return reconstruct(io, accepted.event_id, prior);
    }
  }

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
      const existing = readVaultPage(io.vault_path, page.rel_path);
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
  let receiptId: string | null = null;

  for (const [index, page] of chosen.entries()) {
    const existing = readVaultPage(io.vault_path, page.rel_path);
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
    let receipt: ReturnType<typeof applyCanonWrite>;
    try {
      receipt = applyCanonWrite(canon, stored, writeDecision, {
        writer: "correction",
        budget,
      });
    } catch (error) {
      if (error instanceof CanonWriteError || error instanceof BudgetExhausted) {
        continue;
      }
      throw error;
    }
    if (receiptId === null) receiptId = receipt.receipt_id;
    const after = readVaultPage(io.vault_path, receipt.page_path);
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
    answer: formatAnswer(winner, superseded, rewritten, receiptId, remainder),
  };
}
