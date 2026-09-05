import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../vault/frontmatter";
import { listCanonPagesReport, stringArray } from "../vault/pages";
import { sha256Hex } from "../util/hash";
import { rebuildDerived } from "../derived";

export interface SourceErasureReport {
  logical_absence: boolean;
  owned_file_maintenance: "pending" | "complete";
  external_copies: "out_of_scope";
  affected_claim_ids: string[];
  affected_identity_hashes: string[];
  retained_reasons: string[];
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
  if (
    typeof report.logical_absence !== "boolean" ||
    !["pending", "complete"].includes(report.owned_file_maintenance) ||
    report.external_copies !== "out_of_scope" ||
    ![
      report.affected_claim_ids,
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
      "SELECT 1 FROM canon_receipts c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=? LIMIT 1",
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
  db: Database,
  vault: string,
  source: string,
): SourceErasureReport {
  const prior = sourceErasureReport(db, source);
  const ids = new Set(
    db
      .query<{ event_id: string }, [string]>(
        "SELECT event_id FROM source_event_bindings WHERE source_key=?",
      )
      .all(source)
      .map((row) => row.event_id),
  );
  const claims = db
    .query<{ claim_id: string }, [string]>(
      "SELECT DISTINCT c.claim_id FROM claims c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=? LIMIT 10001",
    )
    .all(source);
  const links = db
    .query<{ subject_a: string; subject_b: string }, [string, string]>(
      "SELECT DISTINCT l.subject_a,l.subject_b FROM identity_links l JOIN json_each(l.evidence) p WHERE replace(p.value,'event:','') IN (SELECT event_id FROM source_event_bindings WHERE source_key=?) OR replace(p.value,'claim:','') IN (SELECT c.claim_id FROM claims c JOIN json_each(c.provenance) e JOIN source_event_bindings b ON b.event_id=e.value WHERE b.source_key=?) LIMIT 10001",
    )
    .all(source, source);
  const report: SourceErasureReport = {
    logical_absence: false,
    owned_file_maintenance: "pending",
    external_copies: "out_of_scope",
    affected_claim_ids: [
      ...new Set([
        ...(prior?.affected_claim_ids ?? []),
        ...claims.map((row) => row.claim_id),
      ]),
    ],
    affected_identity_hashes: [
      ...new Set([
        ...(prior?.affected_identity_hashes ?? []),
        ...links.map((row) =>
          sha256Hex(JSON.stringify([row.subject_a, row.subject_b])),
        ),
      ]),
    ],
    retained_reasons: [],
  };
  if (claims.length > 10000 || links.length > 10000)
    report.retained_reasons.push("bounded_record_limit");
  if (retainedCanon(db, vault, source, ids))
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
    for (const row of links)
      db.query(
        "DELETE FROM identity_links WHERE subject_a=? AND subject_b=?",
      ).run(row.subject_a, row.subject_b);
    for (const row of claims)
      db.query(
        "UPDATE claims SET body='',object=NULL,target=NULL,subject=NULL,predicate=NULL,subjects='[]',frontmatter='{}',model_ref=NULL,producer='deterministic',status='purged' WHERE claim_id=?",
      ).run(row.claim_id);
    db.query(
      "DELETE FROM claim_bindings WHERE claim_key IN (SELECT c.claim_key FROM claims c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.claim_key=claim_bindings.claim_key AND c.status!='purged')",
    ).run(source);
  }).immediate();
  rebuildDerived(db, vault);
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
