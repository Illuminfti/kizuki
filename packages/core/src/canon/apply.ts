import { join } from "node:path";
import type { Sensitivity } from "../agents/types";
import { SENSITIVITY_ORDER } from "../agents/types";
import { getClaim } from "../claims/store";
import type {
  AuthorityTier,
  Claim,
  ClaimTaint,
  FrontmatterValue,
} from "../contracts/proposal";
import { AUTHORITY_TIERS } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import type { VaultPage } from "../vault/frontmatter";
import { PAGE_TYPES } from "../vault/schema";
import { grantCanonWrite, isWriter, writePage } from "../vault/write";
import type { Writer } from "../vault/write";
import { assertPageRelPath } from "./arbiter";
import type { TargetDecision } from "./arbiter";
import type { BudgetTracker } from "./budget";
import { CanonWriteError } from "./errors";
import type { CanonReceipt, PageAction, RetrievalOpRef } from "./receipts";
import { initCanon } from "./schema";
import {
  appendReceiptLine,
  insertReceiptRow,
  mintId,
  nowOf,
  readPage,
  upsertPageIndex,
} from "./store";
import type { CanonIo, ExistingPage } from "./store";

export interface ApplyCanonWriteOptions {
  writer: Writer;
  budget: BudgetTracker;
}

/** Set by the writer; a producer that supplies one is refused (§4.4). */
const RESERVED_KEYS = ["id", "status", "sensitivity", "sources", "taint"] as const;
const MAX_CLAIMS_PER_WRITE = 64;
const MAX_PAGE_CLAIMS = 256;

interface Prepared {
  page: VaultPage;
  action: PageAction;
  taint: ClaimTaint;
  sensitivity: Sensitivity;
}

function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && value in SENSITIVITY_ORDER;
}

function strictest(values: readonly Sensitivity[]): Sensitivity {
  let strictestSoFar: Sensitivity = "public";
  for (const value of values) {
    if (SENSITIVITY_ORDER[value] > SENSITIVITY_ORDER[strictestSoFar]) strictestSoFar = value;
  }
  return strictestSoFar;
}

function lowestAuthority(claims: readonly Claim[]): AuthorityTier {
  let lowest: AuthorityTier = "owner_correction";
  for (const claim of claims) {
    if (AUTHORITY_TIERS[claim.authority] < AUTHORITY_TIERS[lowest]) lowest = claim.authority;
  }
  return lowest;
}

function meanConfidence(claims: readonly Claim[]): number {
  const total = claims.reduce((sum, claim) => sum + claim.confidence, 0);
  return Math.round((total / claims.length) * 1e4) / 1e4;
}

function union(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Claim prose is joined on one line when every body is a single line, and as
 * paragraphs otherwise, so a page's body stays readable Markdown either way.
 */
function composeBody(claims: readonly Claim[]): string {
  const bodies = claims.map((claim) => claim.body.trim()).filter((body) => body.length > 0);
  const separator = bodies.some((body) => body.includes("\n")) ? "\n\n" : " ";
  return `${bodies.join(separator)}\n`;
}

function assertBatch(claims: readonly Claim[]): Claim {
  const primary = claims[0];
  if (primary === undefined) {
    throw new CanonWriteError("nothing_to_write", "a canon write needs at least one claim");
  }
  if (claims.length > MAX_CLAIMS_PER_WRITE) {
    throw new CanonWriteError(
      "batch_too_large",
      `a canon write takes at most ${MAX_CLAIMS_PER_WRITE} claims`,
    );
  }
  for (const claim of claims) {
    if (claim.producer !== primary.producer || claim.model_ref !== primary.model_ref) {
      throw new CanonWriteError("batch_mismatch", "one write, one producer and model reference");
    }
    if (claim.target !== primary.target && (claim.subject === null || claim.subject !== primary.subject)) {
      throw new CanonWriteError("batch_mismatch", "every claim in a write shares the target or the subject");
    }
    if (claim.kind !== primary.kind) {
      throw new CanonWriteError("batch_mismatch", "every claim in a write shares one kind");
    }
    for (const reserved of RESERVED_KEYS) {
      if (reserved in claim.frontmatter) {
        throw new CanonWriteError(
          "frontmatter_reserved",
          `frontmatter: ${reserved} is set by the writer, not by the producer`,
        );
      }
    }
  }
  return primary;
}

function mergedFrontmatter(claims: readonly Claim[]): Record<string, FrontmatterValue> {
  const merged: Record<string, FrontmatterValue> = {};
  for (const claim of claims) {
    for (const key of Object.keys(claim.frontmatter)) {
      const value = claim.frontmatter[key] as FrontmatterValue;
      if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
        throw new CanonWriteError("frontmatter_conflict", `frontmatter: ${key} differs across the write`);
      }
      merged[key] = value;
    }
  }
  return merged;
}

function assertPageType(data: Record<string, unknown>): void {
  const raw = data["type"];
  if (typeof raw !== "string" || !(PAGE_TYPES as readonly string[]).includes(raw)) {
    throw new CanonWriteError(
      "page_type_invalid",
      `frontmatter.type: must be one of ${PAGE_TYPES.join(" | ")}`,
    );
  }
}

function existingSources(page: VaultPage): string[] {
  const raw = page.data["sources"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) {
    throw new CanonWriteError("decision_stale", "existing page sources must be a string array");
  }
  return raw;
}

function assertPersisted(io: CanonIo, claims: readonly Claim[]): void {
  for (const claim of claims) {
    const stored = getClaim(io.db, claim.claim_id);
    if (stored === null) {
      throw new CanonWriteError("claim_unknown", `claim ${claim.claim_id} is not in the claims table`);
    }
    if (stored.body_hash !== claim.body_hash || stored.kind !== claim.kind) {
      throw new CanonWriteError("claim_mismatch", `claim ${claim.claim_id} differs from its stored row`);
    }
    if (stored.status !== "live") {
      throw new CanonWriteError("claim_not_live", `claim ${claim.claim_id} is ${stored.status}`);
    }
    if (stored.receipt_id !== null) {
      throw new CanonWriteError("decision_stale", `claim ${claim.claim_id} was already written`);
    }
  }
}

function assertProvenance(io: CanonIo, provenance: readonly string[]): void {
  if (provenance.length === 0 || !tableExists(io.db, "events")) {
    throw new CanonWriteError("provenance_unresolved", "a canon write needs provenance that resolves");
  }
  const placeholders = provenance.map(() => "?").join(", ");
  const row = io.db
    .query<{ n: number }, string[]>(
      `SELECT count(*) AS n FROM events WHERE event_id IN (${placeholders})`,
    )
    .get(...provenance);
  if (row === null || row.n !== provenance.length) {
    throw new CanonWriteError(
      "provenance_unresolved",
      "provenance: one or more event_ids do not resolve in the ledger",
    );
  }
}

/** Live create-kind claims already materialized on this page, oldest first. */
function liveClaimsOnPage(io: CanonIo, relPath: string, exclude: ReadonlySet<string>): Claim[] {
  const ids = io.db
    .query<{ claim_id: string }, [string, number]>(
      `SELECT c.claim_id AS claim_id
         FROM claims c JOIN canon_receipts r ON r.receipt_id = c.receipt_id
        WHERE r.page_path = ? AND c.status = 'live' AND c.kind IN ('entity', 'claim')
        ORDER BY c.created_at, c.claim_id LIMIT ?`,
    )
    .all(relPath, MAX_PAGE_CLAIMS);
  const claims: Claim[] = [];
  for (const { claim_id } of ids) {
    if (exclude.has(claim_id)) continue;
    const claim = getClaim(io.db, claim_id);
    if (claim !== null) claims.push(claim);
  }
  return claims;
}

function targetOf(decision: TargetDecision): { rel_path: string; page_id: string | null } {
  const target = ((): { rel_path: string; page_id: string | null } => {
    switch (decision.action) {
      case "create":
        return { rel_path: decision.rel_path, page_id: null };
      case "edit":
      case "supersede":
        return { rel_path: decision.rel_path, page_id: decision.page_id };
      case "conflict":
        return { rel_path: decision.chosen.rel_path, page_id: decision.chosen.page_id };
      case "skip":
        throw new CanonWriteError("nothing_to_write", `decision skipped: ${decision.reason}`);
    }
  })();
  assertPageRelPath(target.rel_path);
  if (target.page_id !== null && target.page_id.length === 0) {
    throw new CanonWriteError("decision_stale", "decision names an empty page id");
  }
  return target;
}

function prepareCreate(
  claims: readonly Claim[],
  pageId: string,
  provenance: readonly string[],
  ambiguous: boolean,
): Prepared {
  const extra = mergedFrontmatter(claims);
  const sensitivity = strictest(claims.map((claim) => claim.sensitivity));
  const taint: ClaimTaint = claims.some((claim) => claim.taint === "quoted") ? "quoted" : "clean";
  const data: Record<string, unknown> = {
    id: pageId,
    type: extra["type"],
    status: "active",
    sensitivity,
    taint,
    sources: [...provenance],
  };
  assertPageType(data);
  for (const key of Object.keys(extra).sort()) {
    if (key === "type") continue;
    data[key] = extra[key];
  }
  if (ambiguous) data["x-ambiguous"] = true;
  return { page: { data, body: composeBody(claims) }, action: "create", taint, sensitivity };
}

function prepareRevision(
  io: CanonIo,
  claims: readonly Claim[],
  primary: Claim,
  existing: ExistingPage,
  decision: TargetDecision,
  provenance: readonly string[],
): Prepared {
  const extra = mergedFrontmatter(claims);
  const data: Record<string, unknown> = { ...existing.page.data };
  for (const key of Object.keys(extra).sort()) data[key] = extra[key];
  assertPageType(data);

  const priorSensitivity = existing.page.data["sensitivity"];
  const sensitivity = strictest([
    ...claims.map((claim) => claim.sensitivity),
    ...(isSensitivity(priorSensitivity) ? [priorSensitivity] : []),
  ]);
  const priorTaint: ClaimTaint = existing.page.data["taint"] === "quoted" ? "quoted" : "clean";
  const incomingTaint: ClaimTaint = claims.some((claim) => claim.taint === "quoted") ? "quoted" : "clean";
  const prior = existingSources(existing.page);

  let body: string;
  let taint: ClaimTaint = incomingTaint;
  let sources: string[] = union([prior, provenance]);
  let action: PageAction = "edit";

  switch (primary.kind) {
    case "edit":
      body = composeBody(claims);
      break;
    case "merge":
      body = `${existing.page.body.trimEnd()}\n\n${composeBody(claims)}`;
      taint = priorTaint === "quoted" ? "quoted" : incomingTaint;
      break;
    case "deletion":
      body = existing.page.body;
      taint = priorTaint;
      data["status"] = "archived";
      action = "archive";
      break;
    case "purge_review":
      body = existing.page.body;
      taint = priorTaint;
      sources = prior.filter((source) => !provenance.includes(source));
      break;
    default: {
      const exclude = new Set<string>([
        ...claims.map((claim) => claim.claim_id),
        ...(decision.action === "supersede" ? decision.superseded : []),
      ]);
      const retained = liveClaimsOnPage(io, existing.relPath, exclude);
      body = composeBody([...retained, ...claims]);
      taint = [...retained, ...claims].some((claim) => claim.taint === "quoted") ? "quoted" : "clean";
      break;
    }
  }

  data["sensitivity"] = sensitivity;
  data["taint"] = taint;
  data["sources"] = sources;
  if (decision.action === "conflict") data["x-ambiguous"] = true;
  return { page: { data, body }, action, taint, sensitivity };
}

function supersededRefs(io: CanonIo, decision: TargetDecision): CanonReceipt["superseded"] {
  if (decision.action !== "supersede") return [];
  return decision.superseded.map((claimId) => {
    const loser = getClaim(io.db, claimId);
    if (loser === null || loser.claim_key === null) {
      throw new CanonWriteError("decision_stale", `superseded claim ${claimId} has no conflict key`);
    }
    return { claim_id: claimId, claim_key: loser.claim_key };
  });
}

function recordRow(
  io: CanonIo,
  receipt: CanonReceipt,
  primary: Claim,
  claims: readonly Claim[],
  pageId: string,
  subjectKey: string | null,
): void {
  const ids = claims.map((claim) => claim.claim_id);
  const placeholders = ids.map(() => "?").join(", ");
  io.db.transaction((): void => {
    insertReceiptRow(io.db, receipt, primary.kind);
    io.db
      .query(`UPDATE claims SET receipt_id = ? WHERE claim_id IN (${placeholders})`)
      .run(receipt.receipt_id, ...ids);
    if (tableExists(io.db, "claim_supersessions")) {
      io.db
        .query(`UPDATE claim_supersessions SET receipt_id = ? WHERE winner IN (${placeholders})`)
        .run(receipt.receipt_id, ...ids);
    }
    const bind = io.db.query(
      "INSERT OR IGNORE INTO claim_bindings (claim_key, page_id, bound_at) VALUES (?, ?, ?)",
    );
    for (const claim of claims) {
      if (claim.claim_key !== null) bind.run(claim.claim_key, pageId, receipt.at);
    }
    upsertPageIndex(io.db, {
      page_id: pageId,
      rel_path: receipt.page_path,
      subject_key: subjectKey,
      last_receipt: receipt.receipt_id,
      last_hash: receipt.after_hash,
    });
    if (tableExists(io.db, "proposals")) {
      io.db
        .query(`UPDATE proposals SET status = 'promoted' WHERE proposal_id IN (${placeholders})`)
        .run(...ids);
    }
    if (primary.kind === "purge_review" && tableExists(io.db, "canon_holds")) {
      io.db
        .query(`DELETE FROM canon_holds WHERE page_path = ? AND proposal_id IN (${placeholders})`)
        .run(receipt.page_path, ...ids);
    }
  })();
}

/**
 * The single writer (RFC 0002 §4.5). Order of effects is file → JSONL
 * receipt → database row, so a crash leaves an orphan that `doctor` reports
 * rather than a silent loss. Before/after hashes describe bytes on disk.
 */
export function applyCanonWrite(
  io: CanonIo,
  claim: Claim | readonly Claim[],
  decision: TargetDecision,
  opts: ApplyCanonWriteOptions,
): CanonReceipt {
  if (!isWriter(opts.writer)) {
    throw new CanonWriteError("writer_invalid", "writer must be loop, correction, revert or import");
  }
  const claims: Claim[] = Array.isArray(claim) ? [...(claim as readonly Claim[])] : [claim as Claim];
  const primary = assertBatch(claims);
  const target = targetOf(decision);

  opts.budget.chargeWrite();

  initCanon(io.db);
  assertPersisted(io, claims);
  const provenance = union(claims.map((item) => item.provenance));
  assertProvenance(io, provenance);

  const existing = readPage(io, target.rel_path);
  if (decision.action === "create" && existing !== null) {
    throw new CanonWriteError("page_exists", `page ${target.rel_path} already exists`);
  }
  if (decision.action !== "create") {
    if (existing === null) {
      throw new CanonWriteError("page_missing", `page ${target.rel_path} is gone`);
    }
    if (existing.page.data["id"] !== target.page_id) {
      throw new CanonWriteError("decision_stale", `page ${target.rel_path} changed identity`);
    }
  }

  const pageId = target.page_id ?? mintId(io);
  const receiptId = mintId(io);
  const prepared =
    existing === null
      ? prepareCreate(claims, pageId, provenance, decision.action === "conflict")
      : prepareRevision(io, claims, primary, existing, decision, provenance);
  const superseded = supersededRefs(io, decision);
  const retrievalOps: RetrievalOpRef[] =
    io.retrieval_store === undefined
      ? []
      : [{ store: io.retrieval_store, op: "upsert", doc: `page:${pageId}` }];

  const cap = grantCanonWrite(opts.writer, receiptId);
  const path = join(io.vault_path, target.rel_path);
  const outcome =
    existing === null
      ? writePage(cap, path, prepared.page)
      : writePage(cap, path, prepared.page, { revision: true, expected_hash: existing.hash });

  const receipt: CanonReceipt = {
    receipt_id: receiptId,
    kind: "write",
    claim_ids: claims.map((item) => item.claim_id),
    page_path: target.rel_path,
    page_action: prepared.action,
    before_hash: existing?.hash ?? null,
    after_hash: outcome.after_hash,
    archive_path: outcome.archive_path,
    writer: opts.writer,
    producer: primary.producer,
    model_ref: primary.model_ref,
    authority: lowestAuthority(claims),
    confidence: meanConfidence(claims),
    sensitivity: prepared.sensitivity,
    taint: prepared.taint,
    provenance,
    superseded,
    candidates: decision.action === "conflict" ? decision.candidates : [],
    retrieval_ops: retrievalOps,
    reverts: null,
    reverted_by: null,
    at: nowOf(io),
  };

  appendReceiptLine(io, receipt);
  const priorSubject = existing?.page.data["x-subject-id"];
  recordRow(
    io,
    receipt,
    primary,
    claims,
    pageId,
    primary.subject ?? (typeof priorSubject === "string" ? priorSubject : null),
  );
  return receipt;
}
