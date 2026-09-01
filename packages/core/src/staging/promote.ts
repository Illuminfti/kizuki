import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "../util/ulid";
import { parseFrontmatter, serializePage } from "../vault/frontmatter";
import type { VaultPage } from "../vault/frontmatter";
import { PAGE_TYPES } from "../vault/schema";
import type { PageType } from "../vault/schema";
import { writePage } from "../vault/write";
import { getProposal } from "./proposals";
import type { FrontmatterValue, StagedProposal } from "./proposals";

/**
 * The only door to canon. Architecture invariant 3: nothing writes canon except
 * an owner-invoked promote, so this module refuses to run for any other caller
 * and no scheduled rail may reach it. Pages are rendered and validated by the
 * vault layer — promote owns the gate, the vault owns the format.
 */

export const SENSITIVITY_LEVELS = ["public", "personal", "private"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

export { PAGE_TYPES } from "../vault/schema";
export type { PageType } from "../vault/schema";

/** Frontmatter the spine owns; a producer that sets one is forging provenance. */
const RESERVED_KEYS = ["id", "status", "sensitivity", "sources"] as const;

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 64;

export const RECEIPTS_PATH = ".kizuki/receipts/promotions.jsonl";

export class PromoteError extends Error {
  override name = "PromoteError";
}

export interface PromoteOptions {
  sensitivity: Sensitivity;
  /** Type-level half of the owner gate; the runtime guard below is the other half. */
  invokedBy: "owner";
  /** The owner's edit of the staged body, applied before the page is written. */
  editBody?: string;
}

export interface PromotionReceipt {
  receipt_id: string;
  proposal_id: string;
  provenance: string[];
  sensitivity: Sensitivity;
  page_path: string;
  page_hash: string;
  at: string;
}

function pageType(proposal: StagedProposal): PageType {
  const raw = proposal.frontmatter["type"];
  if (
    typeof raw !== "string" ||
    !(PAGE_TYPES as readonly string[]).includes(raw)
  ) {
    throw new PromoteError(
      `frontmatter.type: must be one of ${PAGE_TYPES.join(" | ")}`,
    );
  }
  return raw as PageType;
}

/**
 * Targets originate in connector data, which is attacker-controlled, so the
 * path is rebuilt from validated segments rather than sanitized in place.
 * Anything with a traversal, a leading dot, or an unexpected character is a
 * refusal — that also keeps promotions out of the `.kizuki` control directory.
 */
export function pageRelPath(proposal: StagedProposal): string {
  const target = proposal.target;
  if (target === null || target.length === 0) {
    return `captures/${proposal.proposal_id}.md`;
  }
  const segments = target.split(/[:/]/);
  if (segments.length > MAX_SEGMENTS) {
    throw new PromoteError(`target: more than ${MAX_SEGMENTS} path segments`);
  }
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH || !PATH_SEGMENT.test(segment)) {
      throw new PromoteError(
        `target: unusable path segment ${JSON.stringify(segment)}`,
      );
    }
  }
  return `${segments.join("/")}.md`;
}

function buildPage(
  proposal: StagedProposal,
  sensitivity: Sensitivity,
  body: string,
): VaultPage {
  for (const reserved of RESERVED_KEYS) {
    if (reserved in proposal.frontmatter) {
      throw new PromoteError(
        `frontmatter: ${reserved} is set by promote, not by the producer`,
      );
    }
  }

  const data: Record<string, unknown> = {
    id: proposal.proposal_id,
    type: pageType(proposal),
    status: "active",
    sensitivity,
    sources: proposal.provenance,
  };
  for (const key of Object.keys(proposal.frontmatter).sort()) {
    if (key === "type") continue;
    data[key] = proposal.frontmatter[key] as FrontmatterValue;
  }

  return { data, body: `\n${body.replace(/\s+$/, "")}\n` };
}

export function renderPage(
  proposal: StagedProposal,
  sensitivity: Sensitivity,
  body: string,
): string {
  return serializePage(buildPage(proposal, sensitivity, body));
}

function hashPage(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * Promotes one staged proposal to canon.
 *
 * The owner gate is enforced twice: `PromoteOptions.invokedBy` is the literal
 * type `"owner"`, so no other caller type-checks, and the runtime guard below
 * rejects a caller that erased the type. `ownerPromote` is the only entry that
 * supplies it.
 */
export function promote(
  db: Database,
  vaultPath: string,
  proposalId: string,
  opts: PromoteOptions,
): PromotionReceipt {
  if (opts.invokedBy !== "owner") {
    throw new PromoteError("promote: canon is written only by the owner");
  }
  if (
    typeof opts.sensitivity !== "string" ||
    !(SENSITIVITY_LEVELS as readonly string[]).includes(opts.sensitivity)
  ) {
    throw new PromoteError(
      `sensitivity: must be one of ${SENSITIVITY_LEVELS.join(" | ")}`,
    );
  }

  const proposal = getProposal(db, proposalId);
  if (proposal === null) {
    throw new PromoteError(`proposal ${proposalId} does not exist`);
  }
  if (proposal.status !== "pending") {
    throw new PromoteError(
      `proposal ${proposalId} is ${proposal.status}, not pending`,
    );
  }

  const relPath = pageRelPath(proposal);
  const pagePath = join(vaultPath, relPath);

  let page: VaultPage;
  if (proposal.kind === "deletion") {
    // Retraction: the owner archives the existing page the tombstoned source
    // fed. The page keeps its identity; only its status flips, and the vault
    // writer preserves the prior revision under archive/.
    if (!existsSync(pagePath)) {
      throw new PromoteError(
        `page ${relPath} does not exist; nothing to retract`,
      );
    }
    page = parseFrontmatter(readFileSync(pagePath, "utf8"));
    page.data["status"] = "archived";
  } else if (existsSync(pagePath)) {
    throw new PromoteError(
      `page ${relPath} already exists; supersede it with an edit proposal`,
    );
  } else {
    page = buildPage(
      proposal,
      opts.sensitivity,
      opts.editBody ?? proposal.body,
    );
  }

  const pageHash = hashPage(serializePage(page));
  const receipt: PromotionReceipt = {
    receipt_id: ulid(),
    proposal_id: proposal.proposal_id,
    provenance: proposal.provenance,
    sensitivity: opts.sensitivity,
    page_path: relPath,
    page_hash: pageHash,
    at: new Date().toISOString(),
  };

  mkdirSync(dirname(pagePath), { recursive: true });
  // The vault writer validates the page against the canon schema and refuses
  // to clobber unless this is a retraction revision; the format has exactly
  // one owner.
  writePage(pagePath, page, { revision: proposal.kind === "deletion" });

  // Receipt first, database second: a crash between the two leaves a visible
  // orphan receipt, which `doctor` can report. The reverse order would leave a
  // promotion the receipts log never mentions.
  const receiptsPath = join(vaultPath, RECEIPTS_PATH);
  mkdirSync(dirname(receiptsPath), { recursive: true });
  appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");

  const record = db.transaction((): void => {
    db.query(
      `INSERT INTO promotions
         (receipt_id, proposal_id, provenance, sensitivity, page_path, page_hash, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.receipt_id,
      receipt.proposal_id,
      JSON.stringify(receipt.provenance),
      receipt.sensitivity,
      receipt.page_path,
      receipt.page_hash,
      receipt.at,
    );
    db.query(
      "UPDATE proposals SET status = 'promoted' WHERE proposal_id = ?",
    ).run(proposal.proposal_id);
  });
  record();

  return receipt;
}

export type OwnerPromoteOptions = Omit<PromoteOptions, "invokedBy">;

/**
 * The owner path — the CLI review surface calls this and nothing else calls
 * `promote`. An invariant test asserts that stays true.
 */
export function ownerPromote(
  db: Database,
  vaultPath: string,
  proposalId: string,
  opts: OwnerPromoteOptions,
): PromotionReceipt {
  return promote(db, vaultPath, proposalId, { ...opts, invokedBy: "owner" });
}

export function readPromotion(
  db: Database,
  proposalId: string,
): PromotionReceipt | null {
  const row = db
    .query("SELECT * FROM promotions WHERE proposal_id = ?")
    .get(proposalId) as {
    receipt_id: string;
    proposal_id: string;
    provenance: string;
    sensitivity: string;
    page_path: string;
    page_hash: string;
    at: string;
  } | null;
  if (row === null) return null;
  return {
    receipt_id: row.receipt_id,
    proposal_id: row.proposal_id,
    provenance: JSON.parse(row.provenance) as string[],
    sensitivity: row.sensitivity as Sensitivity,
    page_path: row.page_path,
    page_hash: row.page_hash,
    at: row.at,
  };
}

export function readReceiptsLog(vaultPath: string): PromotionReceipt[] {
  const receiptsPath = join(vaultPath, RECEIPTS_PATH);
  if (!existsSync(receiptsPath)) return [];
  return readFileSync(receiptsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PromotionReceipt);
}
