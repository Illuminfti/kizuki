import { eraseSourceCanon } from "./source-canon-erasure";
import { requireCanonFiles } from "../canon/io";
import type { CanonIo } from "../canon";
import type { VaultMutationScope } from "../vault/mutation-scope";
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../vault/frontmatter";
import { listCanonPagesReport, stringArray } from "../vault/pages";
import { sha256Hex } from "../util/hash";
import { rebuildDerived } from "../derived";
import { collectLegacyPurgeSubjects, parseLegacyIdentityEvidence, resolveLegacyIdentityRef, scanLegacyIdentityRows } from "../claims/identity";

/** Unique schema-compatible tombstone derived only from opaque identity, never old content. */
export function sourceBodyTombstoneHash(table: "claims" | "proposals", id: string): string {
  return sha256Hex(JSON.stringify(["kizuki.source-erased-body/v1", table, id]));
}

export interface SourceErasureReport {
  logical_absence: boolean;
  owned_file_maintenance: "pending" | "complete";
  external_copies: "out_of_scope";
  affected_claim_ids: string[];
  affected_proposal_ids: string[];
  affected_receipt_ids: string[];
  affected_identity_hashes: string[];
  retained_reasons: string[];
}

function sourceSubjectRefs(db: Database, source: string): Set<string> {
  function* ids(): Generator<string> {
    for (const row of db.query<{ event_id: string }, [string]>(
      "SELECT e.event_id FROM events e JOIN source_event_bindings b ON b.event_id=e.event_id WHERE b.source_key=? ORDER BY e.event_id").iterate(source)) yield row.event_id;
  }
  return collectLegacyPurgeSubjects(db, ids());
}

export function sourceErasureReport(
  db: Database,
  source: string,
): SourceErasureReport | null {
  const row = db
    .query<{ erasure_report: string | null }, [string]>(
      "SELECT erasure_report FROM source_store_inventory WHERE source_key=?",
    )
    .get(source);
  if (row?.erasure_report == null) return null;
  const report = JSON.parse(row.erasure_report) as SourceErasureReport;
  report.affected_receipt_ids ??= [];
  report.affected_proposal_ids ??= [];
  if (
    typeof report.logical_absence !== "boolean" ||
    !["pending", "complete"].includes(report.owned_file_maintenance) ||
    report.external_copies !== "out_of_scope" ||
    ![
      report.affected_claim_ids,
      report.affected_proposal_ids,
      report.affected_receipt_ids,
      report.affected_identity_hashes,
      report.retained_reasons,
    ].every(
      (value) =>
        Array.isArray(value) && value.every((item) => typeof item === "string"),
    )
  )
    throw new Error("source erasure report corrupt");
  return report;
}
function save(db: Database, source: string, report: SourceErasureReport): void {
  db.query(
    "INSERT INTO source_store_inventory (source_key,checked,erasure_report) VALUES (?,0,?) ON CONFLICT(source_key) DO UPDATE SET erasure_report=excluded.erasure_report,payload_complete=0",
  ).run(source, JSON.stringify(report));
}
/** Only known vault canon/archive roots; unreadable or unqualified content is retained. */
function retainedCanon(
  db: Database,
  vault: string,
  source: string,
  ids: Set<string>,
): boolean {
  const pages = listCanonPagesReport(vault);
  if (
    pages.skipped.length > 0 ||
    pages.pages.some((page) =>
      stringArray(page.data["sources"]).some((id) => ids.has(id)),
    )
  )
    return true;
  // Receipts also bind preimages that no longer appear in current canon.
  const receipt = db
    .query(
      "SELECT 1 FROM canon_receipts c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=? AND c.page_path!='' LIMIT 1",
    )
    .get(source);
  if (receipt !== null) return true;
  const archive = join(vault, "archive");
  if (!existsSync(archive)) return false;
  const stack = [archive];
  let count = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    for (const name of readdirSync(dir)) {
      if (++count > 10000) return true;
      const path = join(dir, name);
      const file = lstatSync(path);
      if (file.isSymbolicLink()) return true;
      if (file.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (file.nlink !== 1 || !file.isFile() || file.size > 1024 * 1024)
        return true;
      try {
        const parsed = parseFrontmatter(readFileSync(path, "utf8"));
        const sources = parsed.data["sources"];
        if (
          !Array.isArray(sources) ||
          sources.some((id) => typeof id !== "string")
        )
          return true;
        if (sources.some((id) => ids.has(id as string))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}
/** Native writer ownership held by caller; no external calls in the SQLite transaction. */
export function eraseSourcePayload(
  scope: VaultMutationScope,
  io: CanonIo,
  source: string,
): SourceErasureReport {
  requireCanonFiles(scope, io);
  const { db, vault_path: vault } = io;
  const prior = sourceErasureReport(db, source);
  const ids = new Set<string>();
  for (const row of db.query<{ event_id: string }, [string]>(
    "SELECT event_id FROM source_event_bindings WHERE source_key=?").iterate(source)) {
    if (ids.size >= 1_000_000) throw new Error("source erasure event limit exceeded");
    ids.add(row.event_id);
  }
  const claims = db
    .query<{ claim_id: string; claim_key: string | null }, [string]>(
      "SELECT DISTINCT c.claim_id,c.claim_key FROM claims c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=? LIMIT 10001",
    )
    .all(source);
  const proposals = db.query<{proposal_id:string},[string]>(
    "SELECT DISTINCT p.proposal_id FROM proposals p JOIN json_each(p.provenance) e JOIN source_event_bindings b ON b.event_id=e.value WHERE b.source_key=? LIMIT 10001"
  ).all(source);
  const subjectRefs = sourceSubjectRefs(db, source);
  const claimIds = new Set(claims.map((row) => row.claim_id));
  const links = scanLegacyIdentityRows(db);
  const erasedLinks = links.filter((row) => {
    if (subjectRefs.has(row.subject_a) || subjectRefs.has(row.subject_b)) return true;
    const parsed = parseLegacyIdentityEvidence(row.evidence);
    return parsed.ok && parsed.refs.some((ref) => resolveLegacyIdentityRef(db, ref, ids, claimIds) === "erased");
  });
  const report: SourceErasureReport = {
    logical_absence: false,
    owned_file_maintenance: "pending",
    external_copies: "out_of_scope",
    affected_receipt_ids: [
      ...new Set([
        ...(prior?.affected_receipt_ids ?? []),
        ...db
          .query<{ receipt_id: string }, [string]>(
            "SELECT receipt_id FROM canon_receipts WHERE page_path!='' AND page_path IN (SELECT c.page_path FROM canon_receipts c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?)",
          )
          .all(source)
          .map((row) => row.receipt_id),
      ]),
    ],
    affected_proposal_ids: [...new Set([...(prior?.affected_proposal_ids ?? []), ...proposals.map(row => row.proposal_id)])],
    affected_claim_ids: [
      ...new Set([
        ...(prior?.affected_claim_ids ?? []),
        ...claims.map((row) => row.claim_id),
      ]),
    ],
    // Kept as an empty compatibility field. Guessable endpoint hashes are
    // erased payload too; a resumed operation scrubs older report values.
    affected_identity_hashes: [],
    retained_reasons: [],
  };
  if (claims.length > 10000 || links.length > 10000 || proposals.length > 10000)
    report.retained_reasons.push("bounded_record_limit");
  save(db, source, report);
  if (
    !eraseSourceCanon(scope, io, source) ||
    retainedCanon(db, vault, source, ids)
  )
    report.retained_reasons.push("canon_or_archive_payload_retained");
  if (
    db
      .query(
        "SELECT 1 FROM events e JOIN source_event_bindings b ON e.event_id=b.event_id WHERE b.source_key=? LIMIT 1",
      )
      .get(source) !== null
  )
    report.retained_reasons.push("event_payload_retained");
  save(db, source, report);
  if (report.retained_reasons.length > 0) return report;
  db.exec("PRAGMA secure_delete=ON");
  db.transaction(() => {
    for (const row of erasedLinks)
      db.query(
        "DELETE FROM identity_links WHERE subject_a=? AND subject_b=?",
      ).run(row.subject_a, row.subject_b);
    for (const row of proposals)
      db.query("UPDATE proposals SET body='',body_hash=?,target=NULL,frontmatter='{}',subjects='[]',producer='deterministic',status='withdrawn' WHERE proposal_id=?").run(sourceBodyTombstoneHash("proposals", row.proposal_id), row.proposal_id);
    for (const row of claims)
      db.query(
        "UPDATE claims SET body='',body_hash=?,claim_key=NULL,object=NULL,target=NULL,subject=NULL,predicate=NULL,subjects='[]',frontmatter='{}',model_ref=NULL,producer='deterministic',status='purged' WHERE claim_id=?",
      ).run(sourceBodyTombstoneHash("claims", row.claim_id), row.claim_id);
    // Capture keys before erasure, then remove only bindings with no surviving reference.
    for (const key of new Set(claims.map(row => row.claim_key).filter((key): key is string => key !== null)))
      db.query("DELETE FROM claim_bindings WHERE claim_key=? AND NOT EXISTS (SELECT 1 FROM claims WHERE claim_key=?)").run(key, key);
  }).immediate();
  rebuildDerived(db, vault);
  // DELETE plus VACUUM can retain obsolete tokens in live FTS5 segments.
  // Rebuild from the surviving content before compacting the owned SQLite files.
  db.exec("INSERT INTO search_docs(search_docs) VALUES ('rebuild')");
  for (const row of scanLegacyIdentityRows(db)) {
    const parsed = parseLegacyIdentityEvidence(row.evidence);
    if (!parsed.ok) {
      report.retained_reasons.push("identity_evidence_unresolved");
      break;
    }
    if (subjectRefs.has(row.subject_a) || subjectRefs.has(row.subject_b) || parsed.refs.some((ref) => resolveLegacyIdentityRef(db, ref, ids, claimIds) !== "current")) {
      report.retained_reasons.push("identity_payload_retained");
      break;
    }
  }
  if (report.retained_reasons.length > 0) {
    save(db, source, report);
    return report;
  }
  report.logical_absence = true;
  save(db, source, report);
  return report;
}
/** Bounded busy handling; completion covers owned SQLite files, never external copies. */
export function maintainSourceSqlite(db: Database, source: string): void {
  const report = sourceErasureReport(db, source);
  if (report === null || !report.logical_absence) return;
  const before = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!
    .timeout;
  db.exec("PRAGMA busy_timeout=50");
  try {
    const checkpoint = db
      .query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if (checkpoint?.busy !== 0) return;
    db.exec("VACUUM");
    if (
      db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
        ?.busy !== 0
    )
      return;
    report.owned_file_maintenance = "complete";
    db.query(
      "UPDATE source_store_inventory SET payload_complete=1,erasure_report=? WHERE source_key=?",
    ).run(JSON.stringify(report), source);
    // The final metadata is payload-free, but finish its WAL lifecycle too.
    if (
      db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
        ?.busy !== 0
    ) {
      report.owned_file_maintenance = "pending";
      save(db, source, report);
    }
  } catch {
    report.owned_file_maintenance = "pending";
    save(db, source, report);
  } finally {
    db.exec(`PRAGMA busy_timeout=${before}`);
  }
}
