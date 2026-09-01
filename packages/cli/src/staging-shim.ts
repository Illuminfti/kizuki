// integration: replace with core staging module
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  ulid,
  validateProposal,
} from "@kizuki/core";
import type { CaptureEvent, Proposal, ProposalStatus } from "@kizuki/core";
import {
  assertVault,
  writePage,
} from "./vault-shim";
import type { Sensitivity } from "./vault-shim";

interface ProposalRow {
  content_hash: string;
  created_at: string;
  kind: string;
  payload_json: string;
  producer: string;
  proposal_id: string;
  provenance_json: string;
  status: string;
}

export interface ProposalListItem {
  id: string;
  kind: string;
  producer: string;
  summary: string;
}

export interface PromotionResult {
  pagePath: string;
  receiptId: string;
}

export interface Receipt {
  at: string;
  page_path: string;
  proposal_id: string;
  receipt_id: string;
  sensitivity: Sensitivity;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function proposalHash(
  payload: Record<string, unknown>,
  provenance: string[],
): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sortDeep({ payload, provenance })))
    .digest("hex");
}

function rowToProposal(row: ProposalRow): Proposal {
  const candidate = {
    schema: "kizuki.proposal/v1",
    proposal_id: row.proposal_id,
    kind: row.kind,
    provenance: JSON.parse(row.provenance_json),
    producer: row.producer,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    content_hash: row.content_hash,
    created_at: row.created_at,
  };
  const validation = validateProposal(candidate);
  if (!validation.ok) {
    throw new Error(`invalid stored proposal: ${validation.errors.join(", ")}`);
  }
  return validation.value;
}

function proposalSummary(proposal: Proposal): string {
  const summary = proposal.payload["summary"];
  return typeof summary === "string" ? summary : "";
}

export class Staging {
  private readonly database: Database;
  private readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = assertVault(vaultPath);
    this.database = new Database(join(this.vaultPath, ".kizuki", "kizuki.db"), {
      create: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        producer TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
  }

  close(): void {
    this.database.close();
  }

  createProposalsFromEvents(events: CaptureEvent[]): number {
    let created = 0;
    const claimKind = PROPOSAL_KINDS.find((kind) => kind === "claim");
    if (claimKind === undefined) throw new Error("claim proposal kind unavailable");

    for (const event of events) {
      const payload = {
        summary: event.text.slice(0, 120),
        event_kind: event.kind,
      };
      const provenance = [event.event_id];
      const proposal: Proposal = {
        schema: "kizuki.proposal/v1",
        proposal_id: ulid(),
        kind: claimKind,
        provenance,
        producer: "deterministic",
        status: "pending",
        payload,
        content_hash: proposalHash(payload, provenance),
        created_at: new Date().toISOString(),
      };
      const validation = validateProposal(proposal);
      if (!validation.ok) {
        throw new Error(`invalid proposal: ${validation.errors.join(", ")}`);
      }
      const result = this.database
        .query(`
          INSERT OR IGNORE INTO proposals (
            proposal_id, kind, provenance_json, producer, status,
            payload_json, content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          proposal.proposal_id,
          proposal.kind,
          JSON.stringify(proposal.provenance),
          proposal.producer,
          proposal.status,
          JSON.stringify(proposal.payload),
          proposal.content_hash,
          proposal.created_at,
        );
      if (result.changes === 1) {
        created += 1;
      } else {
        const existing = this.database
          .query("SELECT proposal_id FROM proposals WHERE content_hash = ?")
          .get(proposal.content_hash);
        if (existing === null) throw new Error("proposal id collision");
      }
    }
    return created;
  }

  listProposals(status: ProposalStatus = "pending"): ProposalListItem[] {
    if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid proposal status: ${status}`);
    }
    const rows = this.database
      .query("SELECT * FROM proposals WHERE status = ? ORDER BY proposal_id")
      .all(status) as ProposalRow[];
    return rows.map((row) => {
      const proposal = rowToProposal(row);
      return {
        id: proposal.proposal_id,
        kind: proposal.kind,
        producer: proposal.producer,
        summary: proposalSummary(proposal),
      };
    });
  }

  promote(proposalId: string, sensitivity: Sensitivity): PromotionResult {
    const row = this.database
      .query("SELECT * FROM proposals WHERE proposal_id = ?")
      .get(proposalId) as ProposalRow | null;
    if (row === null) throw new Error(`proposal not found: ${proposalId}`);
    const proposal = rowToProposal(row);
    if (proposal.status !== "pending") {
      throw new Error(`proposal is not pending: ${proposalId}`);
    }

    const receiptId = ulid();
    const pageId = ulid();
    const at = new Date().toISOString();
    const provenance = proposal.provenance.map((eventId) => `- ${eventId}`).join("\n");
    const pagePath = writePage(this.vaultPath, {
      type: "claim",
      sensitivity,
      sources: proposal.provenance,
      id: pageId,
      createdAt: at,
      body: `${proposalSummary(proposal)}\n\n## Provenance\n\n${provenance}`,
    });
    const update = this.database
      .query(
        "UPDATE proposals SET status = 'accepted' WHERE proposal_id = ? AND status = 'pending'",
      )
      .run(proposalId);
    if (update.changes !== 1) {
      throw new Error(`proposal could not be accepted: ${proposalId}`);
    }
    const receipt: Receipt = {
      receipt_id: receiptId,
      proposal_id: proposalId,
      page_path: pagePath,
      sensitivity,
      at,
    };
    appendFileSync(
      join(this.vaultPath, ".kizuki", "receipts.jsonl"),
      `${JSON.stringify(receipt)}\n`,
      "utf8",
    );
    return { pagePath, receiptId };
  }

  reject(proposalId: string, reason: string): void {
    if (reason.trim() === "") throw new Error("rejection reason is required");
    const row = this.database
      .query("SELECT * FROM proposals WHERE proposal_id = ?")
      .get(proposalId) as ProposalRow | null;
    if (row === null) throw new Error(`proposal not found: ${proposalId}`);
    const proposal = rowToProposal(row);
    if (proposal.status !== "pending") {
      throw new Error(`proposal is not pending: ${proposalId}`);
    }
    const payload = { ...proposal.payload, rejection_reason: reason };
    const update = this.database
      .query(
        "UPDATE proposals SET status = 'rejected', payload_json = ? WHERE proposal_id = ? AND status = 'pending'",
      )
      .run(JSON.stringify(payload), proposalId);
    if (update.changes !== 1) {
      throw new Error(`proposal could not be rejected: ${proposalId}`);
    }
  }
}

export function lastReceipts(vaultPath: string, limit = 5): Receipt[] {
  const path = join(assertVault(vaultPath), ".kizuki", "receipts.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  return lines
    .slice(-Math.max(0, Math.floor(limit)))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Receipt);
}
