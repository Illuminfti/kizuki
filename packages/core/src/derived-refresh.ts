import type { Database } from "bun:sqlite";
import { assertDerivedDiscoveryReady, readDerivedHolds } from "./derived-holds";
import { readDerivedMeta, stampDerived, type DerivedStamp } from "./derived-meta";
import { refreshSearchHealth, searchHealthStamp } from "./derived-health";
import { graphHealthStamp, graphProjectionHolds, replacePageEdges, refreshPageEdgesBatch, refreshGraphHealth } from "./graph/graph";
import { initGraph } from "./graph/schema";
import { tableExists } from "./ledger/schema";
import { pageDocument, projectSearchDocs, replacePage, removeCanonPath } from "./search/indexer";
import { initSearch } from "./search/schema";
import { canonFilesStamp, listCanonPagesReport, scanCanonSignatures, type CanonPage, type CanonPageReport } from "./vault/pages";
import { assessWalkEvidence, projectablePageEvidence, type WalkEvidence } from "./vault/provenance";

/** What one pass would write, decided from one walk of the vault and one state of the ledger. */
interface ReconcilePlan {
  /** That state's inputs; see `reconcileLedgerStamp`. */
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

/** Reads only. The caller's transaction fixes the state every answer comes from. */
function planReconcile(db: Database, report: CanonPageReport, hadFts: boolean, hadGraph: boolean): ReconcilePlan {
  const inputs = reconcileLedgerStamp(db);
  assertDerivedDiscoveryReady(db);
  const evidence = assessWalkEvidence(db, report.pages);
  // An unhealthy graph is projected again, unless what is stored is already
  // what this walk and evidence project: that would rewrite the same rows.
  const unhealthy = !hadGraph || (readDerivedMeta(db, "graph")?.status !== "ok"
    && !graphProjectionHolds(db, report.pages, report.skipped.length, evidence));
  if (!hadFts) return { inputs, evidence, withdraw: [], replace: [], restoreFts: true, graph: unhealthy, stamps: [] };
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
  return { inputs, evidence, withdraw, replace, restoreFts: false, graph, stamps };
}

/**
 * Whether the locked state is still the one a plan was read from: every page
 * file has the stat signature its walk saw, and no ledger input has moved
 * since the plan's snapshot. A served call's audit row moves neither.
 */
function planHolds(db: Database, vaultPath: string, report: CanonPageReport, plan: ReconcilePlan): boolean {
  if (reconcileLedgerStamp(db) !== plan.inputs) return false;
  const files = scanCanonSignatures(vaultPath);
  if (files.size !== report.signatures.size) return false;
  for (const [relPath, signature] of report.signatures) if (files.get(relPath) !== signature) return false;
  return true;
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

/** Plans a pass reads off the write lock before it gives way or plans under it. */
const RECONCILE_UNLOCKED_PLANS = 2;

/**
 * How a pass ended. `inputs` are the ledger inputs it leaves verified: those it
 * compared when it found nothing to write, or those its health stamps left
 * when they were all it wrote. It is null after a pass that wrote rows, which
 * the next pass compares again, and after one that gave way without writing.
 */
interface PassResult { readonly wrote: boolean; readonly inputs: string | null }

/**
 * One pass. Each plan is read from its own walk of the vault and its own read
 * snapshot, and is written only if `planHolds` under the write lock. When it
 * does not, another writer changed a page or the ledger while the plan was
 * being read, so nothing is written and the pass reads both again. After
 * RECONCILE_UNLOCKED_PLANS such plans it either gives way, or with `finish`
 * walks and plans under the lock, which no writer can race.
 */
function reconcilePass(db: Database, vaultPath: string, finish: boolean): PassResult {
  const hadFts = tableExists(db, "search_docs");
  const hadGraph = tableExists(db, "graph_edges");
  initSearch(db);
  initGraph(db);
  for (let unlocked = 1; ; unlocked += 1) {
    const report = listCanonPagesReport(vaultPath);
    const plan = db.transaction(() => planReconcile(db, report, hadFts, hadGraph)).deferred();
    if (!plan.restoreFts && !plan.graph && plan.stamps.length === 0) return { wrote: false, inputs: plan.inputs };
    const result = db.transaction((): PassResult | null => {
      if (planHolds(db, vaultPath, report, plan)) {
        applyReconcile(db, report, plan);
        // Stamps change no row the plan compared, so what it verified still
        // stands. One that marks the graph unhealthy is the exception: the
        // next plan answers that by checking the projection.
        const verified = !plan.restoreFts && !plan.graph && plan.stamps.every(stamp => stamp.layer !== "graph" || stamp.status === "ok");
        return { wrote: true, inputs: verified ? reconcileLedgerStamp(db) : null };
      }
      if (unlocked < RECONCILE_UNLOCKED_PLANS) return null;
      if (!finish) return { wrote: false, inputs: null };
      const walked = listCanonPagesReport(vaultPath);
      applyReconcile(db, walked, planReconcile(db, walked, hadFts, hadGraph));
      return { wrote: true, inputs: null };
    }).immediate();
    if (result !== null) return result;
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
 * A pass with something to write takes the lock, checks that no page file and
 * no ledger input has moved since the plan was read, and writes the plan. The
 * lock is held for that check, the writes and the health stamped from them,
 * not for the comparison. This pass always finishes: when writers keep moving
 * its inputs it plans under the lock. Returns whether the pass wrote.
 */
export function reconcileDerivedPages(db: Database, vaultPath: string): boolean {
  return reconcilePass(db, vaultPath, true).wrote;
}

/**
 * Run logs: a row for every rail run, connector run and served call. No page
 * is admitted or projected from them, so they are not inputs of a pass.
 */
const RECONCILE_UNREAD_TABLES: ReadonlySet<string> = new Set(["agent_audit", "connection_runs", "run_receipts"]);

/** Small state a pass reads whole and writers change in place. Every canon write advances the read generation. */
const RECONCILE_STATE_TABLES = ["canon_holds", "canon_write_intents", "canon_projection_obligations", "canon_read_generation", "connector_sensitivity", "derived_meta", "graph_registry"] as const;

/**
 * The ledger as a pass could read it, on the caller's snapshot: the schema
 * version, then for every table but the run logs its row count and, where it
 * has one, its highest rowid, and the small state tables whole. Every table is
 * counted, so one this file has never heard of is covered too. Rows added or
 * removed move a count, and a row added moves the highest rowid unless it
 * takes the place of the newest row. That case, and a row changed in place in
 * a table not read whole, move nothing here. A plan written past such a change
 * is the one a pass just before it would have written, and a skip past it
 * lasts no longer than RECONCILE_RECHECK_MS.
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

/** Passes in a row that may give way to other writers before a handle's next pass finishes under the lock. */
const RECONCILE_RACED_PASSES = 2;

/** What a handle remembers of its last pass. */
interface Refreshed {
  /** The inputs that pass left verified, or null when the next pass has to compare again. */
  readonly settled: { readonly vaultPath: string; readonly files: string; readonly ledger: string; readonly at: number } | null;
  /** Passes in a row that gave way without writing. */
  readonly raced: number;
}
const refreshed = new WeakMap<Database, Refreshed>();

/**
 * `reconcileDerivedPages` for a long-lived handle that refreshes on a timer.
 * A pass is skipped, with no walk, no comparison and no lock, only while all
 * of these hold since a pass on this handle that left its inputs verified:
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
 * The file stamp is taken before the walk, and the ledger stamp on the plan's
 * own snapshot or under the lock that wrote its health stamps, so a change
 * that lands during a pass reads as a change to the next one. A pass that
 * wrote rows moved its own inputs and settles nothing; the pass after it
 * compares again. Every pass that runs reads every page
 * from disk. Nothing is remembered outside the process, so a handle opened
 * after a crash or restart starts with a pass.
 *
 * A timer comes round again, so a pass whose plans were each raced by another
 * writer gives way without writing instead of planning under the lock. Two
 * cases finish regardless, so no repair waits forever: a handle's first pass,
 * since a command that refreshes once has no later pass, and the pass after
 * RECONCILE_RACED_PASSES in a row gave way. Returns whether a pass ran.
 */
export function reconcileDerivedPagesWhenChanged(db: Database, vaultPath: string, now: number = Date.now()): boolean {
  const files = canonFilesStamp(vaultPath, now);
  const last = refreshed.get(db);
  const settled = last?.settled ?? null;
  if (settled !== null && settled.vaultPath === vaultPath && settled.files === files
    && now >= settled.at && now - settled.at < RECONCILE_RECHECK_MS
    && settled.ledger === db.transaction(() => reconcileLedgerStamp(db)).deferred()) return false;
  const pass = reconcilePass(db, vaultPath, last === undefined || last.raced >= RECONCILE_RACED_PASSES);
  refreshed.set(db, {
    settled: pass.inputs === null || files === null ? null : { vaultPath, files, ledger: pass.inputs, at: now },
    raced: pass.wrote || pass.inputs !== null ? 0 : (last?.raced ?? 0) + 1,
  });
  return true;
}
