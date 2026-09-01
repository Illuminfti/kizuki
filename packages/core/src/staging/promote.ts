import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProposalKind } from "../contracts/proposal";
import { ulid } from "../util/ulid";
import { parseFrontmatter, serializePage } from "../vault/frontmatter";
import type { VaultPage } from "../vault/frontmatter";
import { findPageById } from "../vault/pages";
import { PAGE_TYPES } from "../vault/schema";
import type { PageType } from "../vault/schema";
import { writePage } from "../vault/write";
import { getProposal } from "./proposals";
import type { FrontmatterValue, StagedProposal } from "./proposals";

export const SENSITIVITY_LEVELS = ["public", "personal", "private"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

export { PAGE_TYPES } from "../vault/schema";
export type { PageType } from "../vault/schema";

const RESERVED_KEYS = ["id", "status", "sensitivity", "sources"] as const;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 64;

export const RECEIPTS_PATH = ".kizuki/receipts/promotions.jsonl";

export class PromoteError extends Error {
  override name = "PromoteError";
}

export interface PromoteOptions {
  sensitivity?: Sensitivity;
  invokedBy: "owner";
  editBody?: string;
}

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

interface ExistingPage {
  path: string;
  relPath: string;
  content: string;
  page: VaultPage;
}

function assertNoReservedFrontmatter(proposal: StagedProposal): void {
  for (const reserved of RESERVED_KEYS) {
    if (reserved in proposal.frontmatter) {
      throw new PromoteError(
        `frontmatter: ${reserved} is set by promote, not by the producer`,
      );
    }
  }
}

function pageType(proposal: StagedProposal): PageType {
  const raw = proposal.frontmatter["type"];
  if (typeof raw !== "string" || !(PAGE_TYPES as readonly string[]).includes(raw)) {
    throw new PromoteError(
      `frontmatter.type: must be one of ${PAGE_TYPES.join(" | ")}`,
    );
  }
  return raw as PageType;
}

export function pageRelPath(
  proposal: StagedProposal,
  lookup?: PagePathLookup,
): string {
  const target = proposal.target;
  if (target === null || target.length === 0) {
    return `captures/${proposal.proposal_id}.md`;
  }
  const existing = lookup?.(target);
  if (existing !== undefined && existing !== null) return existing;

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

function normalizedBody(body: string): string {
  return `\n${body.replace(/\s+$/, "")}\n`;
}

function buildNewPage(
  proposal: StagedProposal,
  sensitivity: Sensitivity,
  body: string,
): VaultPage {
  assertNoReservedFrontmatter(proposal);
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
  return { data, body: normalizedBody(body) };
}

function existingSources(page: VaultPage): string[] {
  const raw = page.data["sources"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) {
    throw new PromoteError("existing page sources must be a string array");
  }
  return raw;
}

function buildUpdatedPage(
  existing: VaultPage,
  proposal: StagedProposal,
  sensitivity: Sensitivity,
  body: string,
  sources: string[],
): VaultPage {
  assertNoReservedFrontmatter(proposal);
  const data: Record<string, unknown> = { ...existing.data };
  for (const key of Object.keys(proposal.frontmatter).sort()) {
    data[key] = proposal.frontmatter[key] as FrontmatterValue;
  }
  data["sensitivity"] = sensitivity;
  data["sources"] = [...new Set(sources)].sort();
  return { data, body };
}

export function renderPage(
  proposal: StagedProposal,
  sensitivity: Sensitivity,
  body: string,
): string {
  return serializePage(buildNewPage(proposal, sensitivity, body));
}

function hashPage(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function sensitivityFor(
  opts: PromoteOptions,
  existing: ExistingPage | null,
): Sensitivity {
  if (opts.sensitivity !== undefined) {
    if (!(SENSITIVITY_LEVELS as readonly string[]).includes(opts.sensitivity)) {
      throw new PromoteError(
        `sensitivity: must be one of ${SENSITIVITY_LEVELS.join(" | ")}`,
      );
    }
    return opts.sensitivity;
  }
  const inherited = existing?.page.data["sensitivity"];
  if (
    typeof inherited === "string" &&
    (SENSITIVITY_LEVELS as readonly string[]).includes(inherited)
  ) {
    return inherited as Sensitivity;
  }
  throw new PromoteError(
    `sensitivity: must be one of ${SENSITIVITY_LEVELS.join(" | ")}`,
  );
}

function readExisting(
  vaultPath: string,
  proposal: StagedProposal,
): ExistingPage | null {
  const relPath = pageRelPath(proposal, (target) =>
    findPageById(vaultPath, target)?.relPath ?? null,
  );
  const path = join(vaultPath, relPath);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return { path, relPath, content, page: parseFrontmatter(content) };
}

function updatedBody(
  kind: ProposalKind,
  existing: VaultPage,
  proposalBody: string,
  editBody: string | undefined,
): string {
  const body = editBody ?? proposalBody;
  if (kind === "edit") return normalizedBody(body);
  if (kind === "merge") {
    return `${existing.body}\n\n${body}`;
  }
  return editBody === undefined ? existing.body : normalizedBody(editBody);
}

function writePromotionRecord(db: Database, receipt: PromotionReceipt): void {
  db.transaction((): void => {
    db.query(
      `INSERT INTO promotions
         (receipt_id, proposal_id, provenance, sensitivity, page_path,
          kind, before_hash, after_hash, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.receipt_id,
      receipt.proposal_id,
      JSON.stringify(receipt.provenance),
      receipt.sensitivity,
      receipt.page_path,
      receipt.kind,
      receipt.before_hash,
      receipt.after_hash,
      receipt.at,
    );
    db.query(
      "UPDATE proposals SET status = 'promoted' WHERE proposal_id = ?",
    ).run(receipt.proposal_id);
    if (receipt.kind === "purge_review") {
      db.query(
        "DELETE FROM canon_holds WHERE page_path = ? AND proposal_id = ?",
      ).run(receipt.page_path, receipt.proposal_id);
    }
  })();
}

export function promote(
  db: Database,
  vaultPath: string,
  proposalId: string,
  opts: PromoteOptions,
): PromotionReceipt {
  if (opts.invokedBy !== "owner") {
    throw new PromoteError("promote: canon is written only by the owner");
  }
  const proposal = getProposal(db, proposalId);
  if (proposal === null) throw new PromoteError(`proposal ${proposalId} does not exist`);
  if (proposal.status !== "pending") {
    throw new PromoteError(`proposal ${proposalId} is ${proposal.status}, not pending`);
  }

  const existing = readExisting(vaultPath, proposal);
  const createsPage = proposal.kind === "entity" || proposal.kind === "claim";
  if (createsPage && existing !== null) {
    throw new PromoteError(
      `page ${existing.relPath} already exists; supersede it with an edit proposal`,
    );
  }
  if (!createsPage && existing === null) {
    throw new PromoteError(
      `page ${pageRelPath(proposal)} does not exist for ${proposal.kind} proposal`,
    );
  }

  const sensitivity = sensitivityFor(opts, existing);
  assertNoReservedFrontmatter(proposal);
  const beforeHash = existing === null ? null : hashPage(existing.content);
  const relPath = existing?.relPath ?? pageRelPath(proposal);
  let afterContent: string;

  if (createsPage) {
    const page = buildNewPage(proposal, sensitivity, opts.editBody ?? proposal.body);
    const pagePath = join(vaultPath, relPath);
    mkdirSync(dirname(pagePath), { recursive: true });
    writePage(pagePath, page);
    afterContent = readFileSync(pagePath, "utf8");
  } else if (proposal.kind === "deletion") {
    const page: VaultPage = {
      data: {
        ...existing!.page.data,
        status: "archived",
        sensitivity,
      },
      body: existing!.page.body,
    };
    writePage(existing!.path, page, { revision: true });
    afterContent = readFileSync(existing!.path, "utf8");
  } else {
    const priorSources = existingSources(existing!.page);
    const sources = proposal.kind === "purge_review"
      ? priorSources.filter((source) => !proposal.provenance.includes(source))
      : [...priorSources, ...proposal.provenance];
    const page = buildUpdatedPage(
      existing!.page,
      proposal,
      sensitivity,
      updatedBody(proposal.kind, existing!.page, proposal.body, opts.editBody),
      sources,
    );
    writePage(existing!.path, page, { revision: true });
    afterContent = readFileSync(existing!.path, "utf8");
  }

  const receipt: PromotionReceipt = {
    receipt_id: ulid(),
    proposal_id: proposal.proposal_id,
    provenance: proposal.provenance,
    sensitivity,
    page_path: relPath,
    kind: proposal.kind,
    before_hash: beforeHash,
    after_hash: hashPage(afterContent),
    at: new Date().toISOString(),
  };
  const receiptsPath = join(vaultPath, RECEIPTS_PATH);
  mkdirSync(dirname(receiptsPath), { recursive: true });
  appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
  writePromotionRecord(db, receipt);
  return receipt;
}

export type OwnerPromoteOptions = Omit<PromoteOptions, "invokedBy">;

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
    .query<{
      receipt_id: string;
      proposal_id: string;
      provenance: string;
      sensitivity: string;
      page_path: string;
      kind: string;
      before_hash: string | null;
      after_hash: string;
      at: string;
    }, [string]>("SELECT * FROM promotions WHERE proposal_id = ?")
    .get(proposalId);
  if (row === null) return null;
  return {
    receipt_id: row.receipt_id,
    proposal_id: row.proposal_id,
    provenance: JSON.parse(row.provenance) as string[],
    sensitivity: row.sensitivity as Sensitivity,
    page_path: row.page_path,
    kind: row.kind as ProposalKind,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
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
