import type { Database } from "bun:sqlite";
import { assertDerivedDiscoveryReady, readDerivedHolds } from "./derived-holds";
import { readDerivedMeta, stampDerived, type DerivedStamp } from "./derived-meta";
import { refreshSearchHealth, searchHealthStamp } from "./derived-health";
import { graphHealthStamp, graphRegistryHolds, replacePageEdges, refreshPageEdgesBatch, refreshGraphHealth } from "./graph/graph";
import { initGraph } from "./graph/schema";
import { tableExists } from "./ledger/schema";
import { pageDocument, projectSearchDocs, replacePage, removeCanonPath } from "./search/indexer";
import { initSearch } from "./search/schema";
import { canonFilesStamp, listCanonPagesReport, type CanonPage, type CanonPageReport } from "./vault/pages";
import { assessWalkEvidence, projectablePageEvidence, type WalkEvidence } from "./vault/provenance";

/** What one pass would write, decided from one state of the ledger. */
interface ReconcilePlan {
  /** That state's `PRAGMA data_version`, which moves when another connection commits. */
  readonly version: number;
  /** That state's inputs, for a later refresh to tell whether any moved. */
  readonly inputs: string;
  /** Every walked page's evidence in that state. */
  readonly evidence: WalkEvidence;
  /** Stored canon paths to withdraw: pages no longer admitted, and paths the walk no longer found. */
  readonly withdraw: readonly string[];
  /** Admitted pages whose stored projection is missing or differs. */
  readonly replace: readonly CanonPage[];
  /** The FTS table was missing and is restored whole from the stored documents. */
  readonly restoreFts: boolean;
  /** Graph edges are projected again from the walk. */
  readonly graph: boolean;
  /** Health stamps that changed, when nothing else is written. */
  readonly stamps: readonly DerivedStamp[];
}

function dataVersion(db: Database): number {
  return db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
}

function planWrites(plan: ReconcilePlan): boolean {
  return plan.restoreFts || plan.graph || plan.stamps.length > 0;
}

/** Reads only. The caller's transaction fixes the state every answer comes from. */
function planReconcile(db: Database, report: CanonPageReport, hadFts: boolean, hadGraph: boolean): ReconcilePlan {
  // Read first, so the version names the snapshot the rest of the plan reads.
  const version = dataVersion(db);
  const inputs = reconcileLedgerStamp(db);
  assertDerivedDiscoveryReady(db);
  const evidence = assessWalkEvidence(db, report.pages);
  // An unhealthy graph is projected again, unless the registry already holds
  // this very walk and evidence: that projection would rewrite the same rows.
  const unhealthy = !hadGraph || (readDerivedMeta(db, "graph")?.status !== "ok"
    && !graphRegistryHolds(db, report.pages, report.skipped.length, evidence));
  if (!hadFts) return { version, inputs, evidence, withdraw: [], replace: [], restoreFts: true, graph: unhealthy, stamps: [] };
  const admitted = projectablePageEvidence(db, report.pages, evidence);
  for (const path of readDerivedHolds(db).paths) admitted.delete(path);
  const stored = new Map(db.query<{ path: string; doc_id: string; title: string; body: string; page_type: string; sensitivity: string; taint: string; authority: string; subjects: string; provenance: string }, []>(
    "SELECT path, doc_id, title, body, page_type, sensitivity, taint, authority, subjects, provenance FROM search_documents WHERE scope='canon'",
  ).all().map(row => [row.path, row]));
  const served = db.query("SELECT 1 FROM search_docs f JOIN search_documents d ON d.rowid=f.rowid WHERE d.doc_id=? AND f.doc_id=d.doc_id");
  const withdraw: string[] = [];
  const replace: CanonPage[] = [];
  for (const page of report.pages) {
    const basis = admitted.get(page.relPath);
    const previous = stored.get(page.relPath);
    stored.delete(page.relPath);
    if (basis === undefined) {
      if (previous !== undefined) withdraw.push(page.relPath);
      continue;
    }
    const next = pageDocument(page, basis.revision.authority);
    if (previous !== undefined && previous.doc_id === next.docId && previous.title === next.title
      && previous.body === next.body && previous.page_type === next.pageType && previous.sensitivity === next.sensitivity
      && previous.taint === next.taint && previous.authority === next.authority
      && previous.subjects === JSON.stringify(next.subjects) && previous.provenance === JSON.stringify(next.provenance)
      && served.get(next.docId) !== null) continue;
    replace.push(page);
  }
  withdraw.push(...stored.keys());
  const graph = unhealthy || withdraw.length > 0 || replace.length > 0;
  const stamps = graph ? [] : [graphHealthStamp(db, report.pages, report.skipped.length, evidence), searchHealthStamp(db, report, evidence)]
    .filter(stamp => stamp !== null);
  return { version, inputs, evidence, withdraw, replace, restoreFts: false, graph, stamps };
}

/** Writes only. The caller holds the write lock on the state the plan was read from. */
function applyReconcile(db: Database, report: CanonPageReport, plan: ReconcilePlan): void {
  if (plan.restoreFts) projectSearchDocs(db, report.pages, plan.evidence);
  for (const path of plan.withdraw) removeCanonPath(db, path);
  for (const page of plan.replace) replacePage(db, page, plan.evidence);
  if (plan.graph) {
    // A partial walk never certifies a full graph. The existing incremental
    // writer preserves that distinction and withdraws known exclusions.
    if (report.skipped.length === 0) replacePageEdges(db, report.pages, report.signatures, plan.evidence);
    else refreshPageEdgesBatch(db, report.pages, report.pages, report.skipped.length, report.signatures, plan.evidence);
  }
  if (plan.restoreFts || plan.graph) {
    // Health counts what the writes above left behind.
    refreshGraphHealth(db, report.pages, report.skipped.length, plan.evidence);
    refreshSearchHealth(db, report, plan.evidence);
  } else {
    for (const stamp of plan.stamps) stampDerived(db, stamp);
  }
}

/**
 * Plans read off the write lock before a pass plans under it. A plan is
 * discarded only when another connection committed while it was being read.
 */
const RECONCILE_UNLOCKED_PLANS = 2;

/** One pass. Returns the inputs it compared when it found nothing to write, and null when it wrote. */
function reconcilePass(db: Database, report: CanonPageReport): string | null {
  const hadFts = tableExists(db, "search_docs");
  const hadGraph = tableExists(db, "graph_edges");
  initSearch(db);
  initGraph(db);
  for (let unlocked = 1; ; unlocked += 1) {
    const plan = db.transaction(() => planReconcile(db, report, hadFts, hadGraph)).deferred();
    if (!planWrites(plan)) return plan.inputs;
    const written = db.transaction(() => {
      if (dataVersion(db) === plan.version) applyReconcile(db, report, plan);
      else if (unlocked < RECONCILE_UNLOCKED_PLANS) return false;
      else applyReconcile(db, report, planReconcile(db, report, hadFts, hadGraph));
      return true;
    }).immediate();
    if (written) return null;
  }
}

/**
 * Retry current exclusions, including repairs that produced no new receipt.
 *
 * The walk's evidence is assessed, and every page compared with its stored
 * projection, on a read snapshot. That takes no write lock, so readers, and
 * the audit rows they write first, never queue behind a whole-vault
 * comparison. A pass that finds nothing to write ends there.
 *
 * A pass with something to write takes the lock and writes its plan only if
 * no other connection has committed since the plan's snapshot, so the locked
 * state is the very state the plan was read from, and the lock is held for the
 * writes and the health stamped from them, not for the comparison. When one
 * has committed, nothing is written and the plan is read again; after
 * RECONCILE_UNLOCKED_PLANS such races the pass plans under the lock, which no
 * commit can race. Returns whether the pass took the lock to write.
 */
export function reconcileDerivedPages(db: Database, vaultPath: string, report: CanonPageReport = listCanonPagesReport(vaultPath)): boolean {
  return reconcilePass(db, report) === null;
}

/**
 * Run logs: a row for every rail run, connector run and served call. No page
 * is admitted or projected from them, so they are not inputs of a pass.
 */
const RECONCILE_UNREAD_TABLES: ReadonlySet<string> = new Set(["agent_audit", "connection_runs", "run_receipts"]);

/** Small state a pass reads whole and writers change in place. */
const RECONCILE_STATE_TABLES = ["canon_holds", "canon_write_intents", "canon_projection_obligations", "connector_sensitivity", "derived_meta", "graph_registry"] as const;

/**
 * The ledger as a pass could read it, on the caller's snapshot: the schema
 * version, then for every table but the run logs its row count and, where it
 * has one, its highest rowid, and the small state tables whole. Every table is
 * counted, so one this file has never heard of is covered too. Rows added or
 * removed move a count, and a row added moves the highest rowid unless it
 * takes the place of the newest row. That case, and a row changed in place in
 * a table not read whole, move nothing here; see RECONCILE_RECHECK_MS.
 */
function reconcileLedgerStamp(db: Database): string {
  const parts: unknown[] = [db.query("PRAGMA schema_version").get()];
  const tables = db.query<{ name: string; wr: number }, []>(
    "SELECT name, wr FROM pragma_table_list WHERE schema='main' AND type IN ('table', 'shadow') ORDER BY name",
  ).all();
  for (const table of tables) {
    if (RECONCILE_UNREAD_TABLES.has(table.name)) continue;
    const head = table.wr === 1 ? "" : ", max(rowid) AS head";
    parts.push([table.name, db.query(`SELECT count(*) AS n${head} FROM "${table.name.replaceAll('"', '""')}"`).get()]);
  }
  for (const table of RECONCILE_STATE_TABLES) {
    parts.push(tableExists(db, table) ? db.query(`SELECT * FROM ${table}`).all() : null);
  }
  return JSON.stringify(parts);
}

/**
 * Longest a handle goes without a pass. It bounds what the stamps cannot see,
 * such as a ledger row changed in place or a derived row edited by hand.
 */
export const RECONCILE_RECHECK_MS = 30 * 60_000;

/** The inputs of a handle's last pass, when that pass found nothing to write. */
interface Settled { readonly vaultPath: string; readonly files: string; readonly ledger: string; readonly at: number }
const settled = new WeakMap<Database, Settled>();

/**
 * `reconcileDerivedPages` for a long-lived handle that refreshes on a timer.
 * A pass is skipped, with no walk, no comparison and no lock, only while all
 * of these hold since a pass on this handle that found nothing to write:
 *
 * - No page file moved. Editing, adding, removing, renaming or replacing a
 *   page changes a file's stat signature (device, inode, size, modification
 *   and status-change times) or the set of files. Restoring a page's old bytes
 *   and modification time still moves its status-change time, which no caller
 *   can set. A file changed within the racy window of the scan vouches for
 *   nothing: it may change again in the same timestamp tick and keep its size,
 *   so the scan yields no stamp and the next pass runs.
 * - No ledger input moved; see `reconcileLedgerStamp`.
 * - The clock reads later than that pass, by less than RECONCILE_RECHECK_MS.
 *   A clock set back makes files look recent or the pass look ahead, and
 *   either runs a pass.
 *
 * The file stamp is taken before the walk and the ledger stamp on the plan's
 * own snapshot, so a change that lands during a pass reads as a change to the
 * next one. A pass that wrote moved its own inputs and settles nothing; the
 * pass after it compares again. Every pass that runs reads every page from
 * disk. Nothing is remembered outside the process, so a handle opened after a
 * crash or restart starts with a pass. Returns whether a pass ran.
 */
export function reconcileDerivedPagesWhenChanged(db: Database, vaultPath: string, now: number = Date.now()): boolean {
  const files = canonFilesStamp(vaultPath, now);
  const last = settled.get(db);
  if (last !== undefined && last.vaultPath === vaultPath && last.files === files
    && now >= last.at && now - last.at < RECONCILE_RECHECK_MS
    && last.ledger === db.transaction(() => reconcileLedgerStamp(db)).deferred()) return false;
  const ledger = reconcilePass(db, listCanonPagesReport(vaultPath));
  if (ledger === null || files === null) settled.delete(db);
  else settled.set(db, { vaultPath, files, ledger, at: now });
  return true;
}
