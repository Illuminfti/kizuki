import type { Database } from "bun:sqlite";
import { initGraph } from "../graph/schema";
import { removeDoc } from "../search/indexer";
import { initSearch } from "../search/schema";
import { fileProposal } from "../staging/proposals";
import { withdrawForTombstone } from "../staging/producers";
import { ulid } from "../util/ulid";
import { listCanonPagesReport } from "../vault/pages";
import { tableExists } from "./schema";

export interface PurgeReceipt {
  receipt_id: string;
  event_id: string;
  connector_id: string;
  reason: string;
  purged_at: string;
}

export interface CanonHold {
  page_path: string;
  proposal_id: string;
  reason: string;
  held_at: string;
}

export interface PurgeOutcome {
  receipts: PurgeReceipt[];
  withdrawn_proposals: string[];
  canon_holds: { page_path: string; proposal_id: string }[];
}

export type PurgeFilter =
  | { event_id?: string }
  | { connector_id?: string }
  | { subject_handle?: string };

interface PurgeCandidate {
  event_id: string;
  connector_id: string;
}

function selector(filter: PurgeFilter): { where: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if ("event_id" in filter && filter.event_id !== undefined) {
    conditions.push("events.event_id = ?");
    bindings.push(filter.event_id);
  }
  if ("connector_id" in filter && filter.connector_id !== undefined) {
    conditions.push("events.connector_id = ?");
    bindings.push(filter.connector_id);
  }
  if ("subject_handle" in filter && filter.subject_handle !== undefined) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM json_each(events.subjects) AS subject
        WHERE json_extract(subject.value, '$.subject_id') = ?
      )
    `);
    bindings.push(filter.subject_handle);
  }
  if (conditions.length === 0) {
    throw new Error("purgeEvents requires a non-empty filter");
  }
  return { where: conditions.join(" AND "), bindings };
}

function pageSources(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((source) => typeof source === "string")) {
    throw new Error("canon page sources must be a string array");
  }
  return raw;
}

export function purgeEvents(
  db: Database,
  vaultPath: string,
  filter: PurgeFilter,
  reason: string,
): PurgeOutcome {
  const { where, bindings } = selector(filter);

  return db.transaction((): PurgeOutcome => {
    const report = listCanonPagesReport(vaultPath);
    if (report.skipped.length > 0) {
      const relPaths = report.skipped.map(({ relPath }) => relPath).join(", ");
      throw new Error(`purge refused: cannot read canon page(s) ${relPaths}`);
    }

    const candidates = db
      .query<PurgeCandidate, string[]>(
        `SELECT events.event_id, events.connector_id
           FROM events
          WHERE ${where}
          ORDER BY events.accepted_at, events.event_id`,
      )
      .all(...bindings);
    if (candidates.length === 0) {
      return { receipts: [], withdrawn_proposals: [], canon_holds: [] };
    }

    const purgedAt = new Date().toISOString();
    const receipts: PurgeReceipt[] = [];
    const insertReceipt = db.query<
      never,
      [string, string, string, string, string]
    >(
      `INSERT INTO event_purges
         (receipt_id, event_id, connector_id, reason, purged_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteEvent = db.query<never, [string]>(
      "DELETE FROM events WHERE event_id = ?",
    );
    for (const candidate of candidates) {
      const receipt: PurgeReceipt = {
        receipt_id: ulid(),
        event_id: candidate.event_id,
        connector_id: candidate.connector_id,
        reason,
        purged_at: purgedAt,
      };
      insertReceipt.run(
        receipt.receipt_id,
        receipt.event_id,
        receipt.connector_id,
        receipt.reason,
        receipt.purged_at,
      );
      deleteEvent.run(candidate.event_id);
      receipts.push(receipt);
    }

    const purgedIds = candidates.map(({ event_id }) => event_id);
    initSearch(db);
    initGraph(db);
    const removeGraphEdges = db.query<never, [string, string]>(
      "DELETE FROM graph_edges WHERE src = ? OR dst = ?",
    );
    for (const eventId of purgedIds) {
      removeDoc(db, "ledger", eventId);
      removeGraphEdges.run(eventId, eventId);
    }

    const withdrawn = new Set<string>();
    if (tableExists(db, "proposals")) {
      for (const eventId of purgedIds) {
        for (const proposalId of withdrawForTombstone(db, eventId)) {
          withdrawn.add(proposalId);
        }
      }
    }

    // An optional package owns this table; core cannot import it, so the
    // cascade is existence-guarded like the staging guard above.
    if (tableExists(db, "llm_enrichments")) {
      const forget = db.query<never, [string]>(
        "DELETE FROM llm_enrichments WHERE event_id = ?",
      );
      for (const eventId of purgedIds) forget.run(eventId);
    }

    const holds: { page_path: string; proposal_id: string }[] = [];
    for (const page of report.pages) {
      const provenance = pageSources(page.data["sources"])
        .filter((source) => purgedIds.includes(source));
      if (provenance.length === 0) continue;
      const target = page.data["id"];
      if (typeof target !== "string" || target.length === 0) {
        throw new Error(`canon page ${page.relPath} has no usable id`);
      }
      if (!tableExists(db, "proposals")) {
        throw new Error("staging is not initialized for canon purge review");
      }
      const filed = fileProposal(
        db,
        {
          kind: "purge_review",
          target,
          body: page.body,
          frontmatter: {},
          provenance,
          producer: "deterministic",
          confidence: 1,
        },
        { bypassSuppression: true },
      );
      if (filed.outcome === "suppressed") {
        throw new Error("purge review was unexpectedly suppressed");
      }
      const proposalId = filed.proposal.proposal_id;
      db.query(
        `INSERT OR IGNORE INTO canon_holds
           (page_path, proposal_id, reason, held_at)
         VALUES (?, ?, ?, ?)`,
      ).run(page.relPath, proposalId, reason, purgedAt);
      holds.push({ page_path: page.relPath, proposal_id: proposalId });
    }

    return {
      receipts,
      withdrawn_proposals: [...withdrawn].sort(),
      canon_holds: holds,
    };
  }).immediate();
}

export function readHolds(db: Database): CanonHold[] {
  return db
    .query<CanonHold, []>(
      `SELECT page_path, proposal_id, reason, held_at
         FROM canon_holds
        ORDER BY page_path, proposal_id`,
    )
    .all();
}

export function isHeld(db: Database, page_path: string): boolean {
  return db
    .query<{ held: number }, [string]>(
      "SELECT 1 AS held FROM canon_holds WHERE page_path = ? LIMIT 1",
    )
    .get(page_path) !== null;
}
