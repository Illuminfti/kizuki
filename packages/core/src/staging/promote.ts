import type { Database } from "bun:sqlite";
import {
  CanonWriteError,
  applyCanonWrite,
  createBudgetTracker,
  pageRelPath as canonPageRelPath,
  readReceiptsLog as readCanonReceiptsLog,
  receiptsForClaim,
  resolveTarget,
} from "../canon";
import type { CanonReceipt } from "../canon";
import { getClaim } from "../claims/store";
import type { ProposalKind } from "../contracts/proposal";
import { getProposal, setProposalStatus } from "./proposals";
import type { StagedProposal } from "./proposals";

export const SENSITIVITY_LEVELS = ["public", "personal", "private"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

export { PAGE_TYPES } from "../vault/schema";
export type { PageType } from "../vault/schema";
export { RECEIPTS_PATH } from "../canon";

export class PromoteError extends Error {
  override name = "PromoteError";
}

/**
 * @deprecated Leftover Wave 1 surface. RFC 0002 retires promote as the owner
 * path; this shim only routes the leftover CLI/TUI verbs through the
 * receipted writer so no second canon write path exists while those verbs
 * are removed by their own lanes.
 */
export interface PromoteOptions {
  sensitivity?: Sensitivity;
  invokedBy: "owner";
  editBody?: string;
}

/** Legacy projection of a {@link CanonReceipt} keyed by one claim. */
export interface PromotionReceipt {
  receipt_id: string;
  proposal_id: string;
  provenance: string[];
  sensitivity: Sensitivity;
  page_path: string;
  kind: ProposalKind;
  before_hash: string | null;
  after_hash: string;
  at: string;
}

type PagePathLookup = (target: string) => string | null;

export function pageRelPath(
  proposal: StagedProposal,
  lookup?: PagePathLookup,
): string {
  const target = proposal.target;
  if (target !== null && target.length > 0) {
    const existing = lookup?.(target);
    if (existing !== undefined && existing !== null) return existing;
  }
  try {
    return canonPageRelPath({ claim_id: proposal.proposal_id, target });
  } catch (error) {
    if (error instanceof CanonWriteError) throw new PromoteError(error.message);
    throw error;
  }
}

function project(receipt: CanonReceipt, claimId: string, kind: ProposalKind): PromotionReceipt {
  return {
    receipt_id: receipt.receipt_id,
    proposal_id: claimId,
    provenance: receipt.provenance,
    sensitivity: receipt.sensitivity,
    page_path: receipt.page_path,
    kind,
    before_hash: receipt.before_hash,
    after_hash: receipt.after_hash,
    at: receipt.at,
  };
}

/**
 * @deprecated See {@link PromoteOptions}. Writes through `applyCanonWrite`
 * with `writer: "import"`, the same stamp a pre-RFC promotion receipt
 * migrates to.
 */
export function promote(
  db: Database,
  vaultPath: string,
  proposalId: string,
  opts: PromoteOptions,
): PromotionReceipt {
  if (opts.editBody !== undefined) {
    throw new PromoteError(
      "editBody: the receipted writer materializes stored claims only; hand edits are owner-authored evidence, not promote input",
    );
  }
  if (
    opts.sensitivity !== undefined &&
    !(SENSITIVITY_LEVELS as readonly string[]).includes(opts.sensitivity)
  ) {
    throw new PromoteError(
      `sensitivity: must be one of ${SENSITIVITY_LEVELS.join(" | ")}`,
    );
  }
  const proposal = getProposal(db, proposalId);
  if (proposal === null) throw new PromoteError(`proposal ${proposalId} does not exist`);
  if (proposal.status !== "pending") {
    throw new PromoteError(`proposal ${proposalId} is ${proposal.status}, not pending`);
  }

  setProposalStatus(db, proposalId, "promoted");
  try {
    const stored = getClaim(db, proposalId);
    if (stored === null) {
      throw new PromoteError(`proposal ${proposalId} has no claim row`);
    }
    const claim = opts.sensitivity === undefined ? stored : { ...stored, sensitivity: opts.sensitivity };
    const io = { db, vault_path: vaultPath };
    const decision = resolveTarget(io, claim);
    if (decision.action === "skip") {
      throw new PromoteError(`proposal ${proposalId} was not written: ${decision.reason}`);
    }
    const receipt = applyCanonWrite(io, claim, decision, {
      writer: "import",
      budget: createBudgetTracker({ canon_writes_per_run: 1 }),
    });
    return project(receipt, proposalId, proposal.kind);
  } catch (error) {
    setProposalStatus(db, proposalId, "pending");
    if (error instanceof CanonWriteError) throw new PromoteError(error.message);
    throw error;
  }
}

export type OwnerPromoteOptions = Omit<PromoteOptions, "invokedBy">;

/** @deprecated See {@link promote}. */
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
  const receipt = receiptsForClaim(db, proposalId)[0];
  if (receipt === undefined) return null;
  const claim = getClaim(db, proposalId);
  return project(receipt, proposalId, claim?.kind ?? "claim");
}

/** @deprecated Prefer the `CanonReceipt` log from `@kizuki/core`. */
export function readReceiptsLog(vaultPath: string): CanonReceipt[] {
  return readCanonReceiptsLog(vaultPath);
}
