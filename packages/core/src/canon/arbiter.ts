import { targetProblem } from "../contracts/page-candidate";
import type { Claim, ClaimKind } from "../contracts/proposal";
import { AUTHORITY_TIERS } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { findPageById } from "../vault/pages";
import { CanonWriteError } from "./errors";
import type { PageCandidate } from "./receipts";
import { latestReceiptForPage, listCanonReceipts } from "./receipts";
import { initCanon } from "./schema";
import { pageIndexById, pagesForSubject, readPage } from "./store";
import type { CanonIo, PageIndexEntry } from "./store";

export type EditReason = "bound" | "explicit" | "subject";

/** RFC 0002 §4.4. */
export type TargetDecision =
  | { action: "create"; rel_path: string }
  | { action: "edit"; page_id: string; rel_path: string; reason: EditReason }
  | {
      action: "supersede";
      page_id: string;
      rel_path: string;
      superseded: string[];
    }
  | {
      action: "skip";
      reason: "duplicate" | "below_floor" | "owner_edited_body";
    }
  | { action: "conflict"; candidates: PageCandidate[]; chosen: PageCandidate };

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 64;

/** Kinds that mint a page; the rest require one (§4.4, structural refusals). */
const CREATE_KINDS: ReadonlySet<ClaimKind> = new Set(["entity", "claim"]);
/** Kinds whose write would replace or extend prose; §4.4 rule 7 protects it. */
const PROSE_KINDS: ReadonlySet<ClaimKind> = new Set([
  "entity",
  "claim",
  "edit",
  "merge",
]);

/**
 * Path derivation is unchanged from the pre-RFC promote: `target` split on
 * `[:/]`, at most 8 segments of at most 64 chars, `captures/<claim_id>.md`
 * when the target is null. The grammar itself lives with the contract, so a
 * producer can check a target it is about to mint against the same rule the
 * writer will apply rather than against a copy of it.
 */
export function pageRelPath(claim: {
  claim_id: string;
  target: string | null;
}): string {
  const target = claim.target;
  if (target === null || target.length === 0) {
    return `captures/${claim.claim_id}.md`;
  }
  const problem = targetProblem(target);
  if (problem !== null) throw new CanonWriteError("target_invalid", problem);
  return `${target.split(/[:/]/).join("/")}.md`;
}

/**
 * A decision is caller-built, so the writer re-validates the path it names:
 * vault-relative, Markdown, the same segment rules as `pageRelPath`, and
 * never the archive directory or a doctrine file.
 */
export function assertPageRelPath(relPath: string): void {
  const segments = relPath.split("/");
  const last = segments.at(-1);
  if (
    segments.length > MAX_SEGMENTS ||
    last === undefined ||
    !last.endsWith(".md") ||
    last.length <= 3 ||
    segments[0] === "archive" ||
    (segments.length === 1 && (last === "CANON.md" || last === "SCHEMA.md"))
  ) {
    throw new CanonWriteError(
      "target_invalid",
      "decision names an unusable page path",
    );
  }
  for (const [index, segment] of segments.entries()) {
    const limit =
      index === segments.length - 1
        ? MAX_SEGMENT_LENGTH + 3
        : MAX_SEGMENT_LENGTH;
    if (segment.length > limit || !PATH_SEGMENT.test(segment)) {
      throw new CanonWriteError(
        "target_invalid",
        "decision names an unusable page path",
      );
    }
  }
}

interface ResolvedPage {
  page_id: string;
  rel_path: string;
}

function pageAt(io: CanonIo, relPath: string): ResolvedPage | null {
  const existing = readPage(io, relPath);
  if (existing === null) return null;
  const id = existing.page.data["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  return { page_id: id, rel_path: relPath };
}

function resolvePageById(io: CanonIo, pageId: string): ResolvedPage | null {
  const indexed = pageIndexById(io.db, pageId);
  if (indexed !== null) {
    const onDisk = pageAt(io, indexed.rel_path);
    if (onDisk !== null && onDisk.page_id === pageId) return onDisk;
  }
  const scanned = findPageById(io.vault_path, pageId);
  return scanned === null
    ? null
    : { page_id: scanned.id, rel_path: scanned.relPath };
}

function candidateFor(io: CanonIo, entry: PageIndexEntry): PageCandidate {
  const latest = latestReceiptForPage(io.db, entry.rel_path);
  const first = listCanonReceipts(io.db, {
    page_path: entry.rel_path,
    limit: 1,
  })[0];
  return {
    page_id: entry.page_id,
    rel_path: entry.rel_path,
    authority: latest?.authority ?? "owner_authored",
    created_at: first?.at ?? "",
  };
}

/** Highest authority of the most recent write, then oldest, then smallest id. */
export function chooseCandidate(
  candidates: readonly PageCandidate[],
): PageCandidate {
  const sorted = [...candidates].sort((left, right) => {
    const tier =
      AUTHORITY_TIERS[right.authority] - AUTHORITY_TIERS[left.authority];
    if (tier !== 0) return tier;
    if (left.created_at !== right.created_at) {
      return left.created_at < right.created_at ? -1 : 1;
    }
    return left.page_id < right.page_id
      ? -1
      : left.page_id > right.page_id
        ? 1
        : 0;
  });
  const chosen = sorted[0];
  if (chosen === undefined) {
    throw new CanonWriteError(
      "page_missing",
      "conflict resolution needs at least one candidate",
    );
  }
  return chosen;
}

/**
 * Rule 7: a page whose bytes differ from the `after_hash` of its most recent
 * receipt was edited by hand (or has no receipt at all). The writer must not
 * replace that prose.
 */
export function ownerEdited(io: CanonIo, relPath: string): boolean {
  const existing = readPage(io, relPath);
  if (existing === null) return false;
  const latest = latestReceiptForPage(io.db, relPath);
  return latest === null || latest.after_hash !== existing.hash;
}

function guardProse(
  io: CanonIo,
  claim: Claim,
  relPath: string,
  decision: TargetDecision,
): TargetDecision {
  if (PROSE_KINDS.has(claim.kind) && ownerEdited(io, relPath)) {
    return { action: "skip", reason: "owner_edited_body" };
  }
  return decision;
}

function boundPage(io: CanonIo, claim: Claim): ResolvedPage | null {
  if (claim.claim_key === null || !tableExists(io.db, "claim_bindings"))
    return null;
  const rows = io.db
    .query<{ page_id: string }, [string]>(
      "SELECT page_id FROM claim_bindings WHERE claim_key = ? ORDER BY bound_at DESC, page_id LIMIT 16",
    )
    .all(claim.claim_key);
  for (const row of rows) {
    const page = resolvePageById(io, row.page_id);
    if (page !== null) return page;
  }
  return null;
}

function explicitPage(io: CanonIo, claim: Claim): ResolvedPage | null {
  if (claim.target === null) return null;
  return resolvePageById(io, claim.target) ?? pageAt(io, pageRelPath(claim));
}

interface Supersession {
  /** Every loser the claims store recorded for this winner. */
  losers: string[];
  /** The page a written loser lives on, when one exists. */
  page: ResolvedPage | null;
}

/**
 * Supersession itself is decided by the claims store (§5.3) before the
 * writer runs; the arbiter only reads what it recorded. A written loser's
 * key is always bound (rule 1) so the page is found by rules 1, 2 or 4 and
 * the action is upgraded to `supersede`; rule 3 is the fallback when nothing
 * else names the loser's page.
 */
function supersessionOf(io: CanonIo, claim: Claim): Supersession {
  if (!tableExists(io.db, "claim_supersessions"))
    return { losers: [], page: null };
  const rows = io.db
    .query<{ loser: string; receipt_id: string | null }, [string]>(
      `SELECT s.loser AS loser, c.receipt_id AS receipt_id
         FROM claim_supersessions s LEFT JOIN claims c ON c.claim_id = s.loser
        WHERE s.winner = ? ORDER BY s.at DESC, s.loser LIMIT 64`,
    )
    .all(claim.claim_id);
  const losers = rows.map((row) => row.loser);
  for (const row of rows) {
    if (row.receipt_id === null) continue;
    const receipt = io.db
      .query<{ page_path: string }, [string]>(
        "SELECT page_path FROM canon_receipts WHERE receipt_id = ?",
      )
      .get(row.receipt_id);
    if (receipt === null) continue;
    const page = pageAt(io, receipt.page_path);
    if (page !== null) return { losers, page };
  }
  return { losers, page: null };
}

function onPage(
  io: CanonIo,
  claim: Claim,
  page: ResolvedPage,
  reason: EditReason,
  supersession: Supersession,
): TargetDecision {
  const decision: TargetDecision =
    supersession.losers.length > 0
      ? { action: "supersede", ...page, superseded: supersession.losers }
      : { action: "edit", ...page, reason };
  return guardProse(io, claim, page.rel_path, decision);
}

/**
 * Rules evaluated in RFC 0002 §4.4 order; the first that matches wins. A
 * conflict never opens a queue: it is resolved deterministically and every
 * candidate is recorded on the receipt.
 */
export function resolveTarget(io: CanonIo, claim: Claim): TargetDecision {
  initCanon(io.db);

  if (
    claim.status === "superseded" ||
    claim.status === "purged" ||
    claim.status === "reverted"
  ) {
    throw new CanonWriteError(
      "claim_not_live",
      `claim ${claim.claim_id} is ${claim.status}`,
    );
  }
  if (claim.receipt_id !== null) return { action: "skip", reason: "duplicate" };
  if (claim.status === "skipped" || claim.confidence <= 0) {
    return { action: "skip", reason: "below_floor" };
  }

  const supersession = supersessionOf(io, claim);

  const bound = boundPage(io, claim);
  if (bound !== null) return onPage(io, claim, bound, "bound", supersession);

  const explicit = explicitPage(io, claim);
  if (explicit !== null)
    return onPage(io, claim, explicit, "explicit", supersession);

  if (supersession.page !== null) {
    return onPage(io, claim, supersession.page, "bound", supersession);
  }

  if (claim.subject !== null) {
    const pages = pagesForSubject(io.db, claim.subject).filter(
      (entry) => pageAt(io, entry.rel_path)?.page_id === entry.page_id,
    );
    const only = pages[0];
    if (pages.length === 1 && only !== undefined) {
      return onPage(
        io,
        claim,
        { page_id: only.page_id, rel_path: only.rel_path },
        "subject",
        supersession,
      );
    }
    if (pages.length > 1) {
      const candidates = pages.map((entry) => candidateFor(io, entry));
      const chosen = chooseCandidate(candidates);
      return guardProse(io, claim, chosen.rel_path, {
        action: "conflict",
        candidates,
        chosen,
      });
    }
  }

  if (!CREATE_KINDS.has(claim.kind)) {
    throw new CanonWriteError(
      "page_required",
      `page ${pageRelPath(claim)} does not exist for ${claim.kind} claim`,
    );
  }
  return { action: "create", rel_path: pageRelPath(claim) };
}
