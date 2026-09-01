import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "../util/ulid";
import { getProposal } from "./proposals";
import type { FrontmatterValue, StagedProposal } from "./proposals";

/**
 * The only door to canon. Architecture invariant 3: nothing writes canon except
 * an owner-invoked promote, so this module refuses to run for any other caller
 * and no scheduled rail may reach it.
 */

export const SENSITIVITY_LEVELS = ["public", "personal", "private"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** Closed enum: an unknown page type is a refusal, not a new type. */
export const PAGE_TYPES = [
  "person",
  "org",
  "place",
  "project",
  "note",
  "claim",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** Frontmatter the spine owns; a producer that sets one is forging provenance. */
const RESERVED_KEYS = ["id", "status", "sensitivity", "sources"] as const;

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
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

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PromoteError("frontmatter: numbers must be finite");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  // Every string is double-quoted and escaped, so captured text cannot inject
  // a key, close the fence, or start a nested document.
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `"${out}"`;
}

function yamlEntry(key: string, value: FrontmatterValue): string {
  if (!KEY.test(key)) {
    throw new PromoteError(`frontmatter: unusable key ${JSON.stringify(key)}`);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return [`${key}:`, ...value.map((item) => `  - ${yamlScalar(item)}`)].join(
      "\n",
    );
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new PromoteError(
      `frontmatter: ${key} must be a scalar or an array of scalars`,
    );
  }
  return `${key}: ${yamlScalar(value)}`;
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

export function renderPage(
  proposal: StagedProposal,
  sensitivity: Sensitivity,
  body: string,
): string {
  for (const reserved of RESERVED_KEYS) {
    if (reserved in proposal.frontmatter) {
      throw new PromoteError(
        `frontmatter: ${reserved} is set by promote, not by the producer`,
      );
    }
  }

  const lines = [
    yamlEntry("id", proposal.proposal_id),
    yamlEntry("type", pageType(proposal)),
    yamlEntry("status", "active"),
    yamlEntry("sensitivity", sensitivity),
    yamlEntry("sources", proposal.provenance),
  ];
  for (const key of Object.keys(proposal.frontmatter).sort()) {
    if (key === "type") continue;
    lines.push(yamlEntry(key, proposal.frontmatter[key] as FrontmatterValue));
  }

  const trimmed = body.replace(/\s+$/, "");
  return `---\n${lines.join("\n")}\n---\n\n${trimmed}\n`;
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
  if (existsSync(pagePath)) {
    throw new PromoteError(
      `page ${relPath} already exists; supersede it with an edit proposal`,
    );
  }

  const content = renderPage(
    proposal,
    opts.sensitivity,
    opts.editBody ?? proposal.body,
  );
  const pageHash = hashPage(content);
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
  writeFileSync(pagePath, content, { encoding: "utf8", flag: "wx" });

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
