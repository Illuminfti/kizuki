import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { recordedPage } from "../helpers/recorded-page";

/** The comparison's read of every stored canon row, which a pass issues once per plan. */
export const STORED_ROWS_SQL = "SELECT path, doc_id, title, body, page_type";

const page = (id: string) => ({ id: `fact:${id}`, title: id, type: "fact", status: "active", sensitivity: "public", taint: "clean" });

/** A file-backed vault with two recorded pages, and further connections to the same ledger. */
export async function reconcileFixture(cleanup: (() => void)[]) {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-reconcile-"));
  initVault(vault);
  const dbPath = join(vault, ".kizuki/kizuki.db");
  const db = openLedger(dbPath);
  cleanup.push(() => rmSync(vault, { recursive: true, force: true }));
  cleanup.push(() => db.close());
  for (const name of ["tea", "kettle"]) await recordedPage(db, vault, `facts/${name}.md`, page(name), `${name} with [[Cup]].`);
  /** Another connection, which refuses at once instead of waiting for the write lock. */
  const other = (busyTimeoutMs = 0): Database => {
    const handle = openLedger(dbPath, { busyTimeoutMs });
    cleanup.push(() => handle.close());
    return handle;
  };
  const indexed = () => db.query<{ path: string }, []>("SELECT path FROM search_documents WHERE scope='canon' ORDER BY path").all().map(row => row.path);
  return { vault, dbPath, db, other, indexed };
}

/** Runs `work` on `db` while another connection holds the write lock `db` will not wait for. */
export function underForeignWriteLock<T>(db: Database, writer: Database, work: () => T): T {
  db.exec("PRAGMA busy_timeout = 0");
  writer.exec("BEGIN IMMEDIATE");
  try { return work(); } finally { writer.exec("ROLLBACK"); db.exec("PRAGMA busy_timeout = 5000"); }
}

/** Calls `seen` with each statement `db` prepares through `query` while `work` runs. */
export function watchingQueries<T>(db: Database, seen: (sql: string) => void, work: () => T): T {
  const query = db.query.bind(db);
  db.query = ((sql: string) => { seen(sql); return query(sql); }) as typeof db.query;
  try { return work(); } finally { db.query = query; }
}

/** A child process that holds the ledger's write lock for `holdMs`, resolved once it holds it. */
export async function foreignWriter(dbPath: string, holdMs: number): Promise<{ exited: Promise<number> }> {
  const holder = Bun.spawn([process.execPath, "-e", `
    const { Database } = require("bun:sqlite");
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    console.log("held");
    Bun.sleepSync(${holdMs});
    db.exec("ROLLBACK");
  `, dbPath], { stdout: "pipe" });
  const first = await holder.stdout.getReader().read();
  if (!new TextDecoder().decode(first.value).includes("held")) throw new Error("foreign writer did not take the lock");
  return { exited: holder.exited };
}
