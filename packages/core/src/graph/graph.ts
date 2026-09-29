import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import type { RetrievalAuthority } from "../contracts/retrieval";
import { readDerivedMeta, stampDerived } from "../derived-meta";
import type { DerivedStamp } from "../derived-meta";
import { assertDerivedDiscoveryReady, markDerivedHeld, readDerivedHolds } from "../derived-holds";
import { latestLedgerCursor } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { bareRetrievalId } from "../retrieval/ids";
import { ulid } from "../util/ulid";
import { compareText } from "../util/order";
import { placeholders } from "../util/sql";
import {
  canonPagesHash,
  isLiveCanonPage,
  listCanonPagesReport,
  stringArray,
} from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { projectablePageEvidence } from "../vault/provenance";
import { linkIndexFromTargets, linkKeys, resolveWikilink } from "./resolve";
import type { LinkIndex } from "./resolve";
import { initGraph } from "./schema";

export type GraphEdgeKind = "wikilink" | "subject" | "source";

export interface GraphEdge {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
}

export interface GraphRebuildInput {
  generation: string;
  pages: readonly CanonPage[];
  skipped: readonly SkippedPage[];
  /** Stat signatures of the walk, so later refreshes can tell the vault has not changed. */
  signatures?: ReadonlyMap<string, string>;
  rebuilt_at: string;
  canon_hash: string | null;
}

export interface GraphRebuildResult {
  pages: number;
  edges: number;
  skipped: SkippedPage[];
  rebuilt_at: string;
  generation: string;
  status: "ok" | "degraded";
}

export interface NeighborOptions {
  depth?: 1 | 2;
  kinds?: GraphEdgeKind[];
  limit?: number;
  ceiling?: Sensitivity;
}

export interface NeighborResult {
  id: string;
  edges: GraphEdge[];
  truncated: boolean;
}

interface StoredEdge {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
  sensitivity: string;
  dest_sensitivity: string | null;
  taint: "clean" | "quoted";
  authority: RetrievalAuthority;
  provenance: string;
}

const FRONTIER_CHUNK = 500;

function withoutCodeSpans(body: string): string {
  const runs: { start: number; length: number; next: number }[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "`") continue;
    const start = index;
    while (body[index + 1] === "`") index += 1;
    runs.push({ start, length: index - start + 1, next: -1 });
  }
  if (runs.length === 0) return body;

  // Index the next exact-length run once. Unmatched runs must not each
  // rescan the rest of a hostile page looking for a closing delimiter.
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    run.next = nextByLength.get(run.length) ?? -1;
    nextByLength.set(run.length, index);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < runs.length;) {
    const run = runs[index]!;
    if (run.next < 0) {
      index += 1;
      continue;
    }
    const closing = runs[run.next]!;
    const end = closing.start + closing.length;
    parts.push(body.slice(cursor, run.start));
    parts.push(body.slice(run.start, end).replace(/[^\n]/g, " "));
    cursor = end;
    index = run.next + 1;
  }
  parts.push(body.slice(cursor));
  return parts.join("");
}

function wikilinks(body: string): string[] {
  const source = withoutCodeSpans(body);
  if (!source.includes("[[")) return [];
  const targets: string[] = [];

  // For each suffix, find the first closing pair after any balanced nested
  // groups. Right-to-left construction makes every lookup constant-time,
  // including an unmatched opener and overlapping delimiters such as [[[.
  const closes = new Int32Array(source.length + 2).fill(-1);
  const nested = new Uint8Array(source.length + 2);
  for (let index = source.length - 2; index >= 0; index -= 1) {
    if (source[index] === "]" && source[index + 1] === "]") {
      closes[index] = index;
    } else if (source[index] === "[" && source[index + 1] === "[") {
      const innerEnd = closes[index + 2]!;
      if (innerEnd >= 0) closes[index] = closes[innerEnd + 2]!;
      nested[index] = 1;
    } else {
      closes[index] = closes[index + 1]!;
      nested[index] = nested[index + 1]!;
    }
  }

  for (let index = 0; index < source.length - 1; index += 1) {
    if (source[index] !== "[" || source[index + 1] !== "[") continue;
    const contentStart = index + 2;
    const closing = closes[contentStart]!;
    if (closing < 0) continue;
    if (nested[contentStart] === 0) {
      const content = source.slice(contentStart, closing);
      const separator = content.indexOf("|");
      const target = (separator < 0 ? content : content.slice(0, separator)).trim();
      if (target.length > 0) targets.push(target);
    }
    index = closing + 1;
  }

  return targets;
}

function pageSensitivity(page: CanonPage): string {
  const value = page.data["sensitivity"];
  return value === "public" || value === "personal" || value === "private"
    ? value
    : "unlabeled";
}

function pageTaint(page: CanonPage): "clean" | "quoted" {
  return page.data["taint"] === "quoted" ? "quoted" : "clean";
}


function destSensitivity(
  kind: GraphEdgeKind,
  dst: string,
  projected: ReadonlyMap<string, PageRow>,
  eventHints: ReadonlyMap<string, string>,
): string | null {
  switch (kind) {
    case "wikilink":
      return projected.get(dst)?.sensitivity ?? null;
    case "subject":
      return null;
    case "source":
      return eventHints.get(bareRetrievalId(dst)) ?? "unlabeled";
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unexpected graph edge kind: ${_exhaustive}`);
    }
  }
}

function eventSensitivityHints(
  db: Database,
  eventIds: readonly string[],
): Map<string, string> {
  const hints = new Map<string, string>();
  if (eventIds.length === 0 || !tableExists(db, "events")) return hints;
  for (const group of chunks(eventIds, FRONTIER_CHUNK)) {
    const rows = db
      .query<{ event_id: string; sensitivity_hint: string | null }, string[]>(
        `SELECT event_id, sensitivity_hint FROM events
          WHERE event_id IN (${placeholders(group.length)})`,
      )
      .all(...group);
    for (const row of rows) {
      const hint = row.sensitivity_hint;
      hints.set(
        row.event_id,
        hint === "public" || hint === "personal" || hint === "private"
          ? hint
          : "unlabeled",
      );
    }
  }
  return hints;
}


/**
 * What the registry keeps about one page: enough to project its edges, and to
 * find every edge its identity touches, without reading the vault again.
 */
interface PageRow {
  readonly id: string;
  readonly relPath: string;
  readonly title: string | null;
  readonly active: boolean;
  /** Live evidence and derive consent hold; only an admitted page projects edges. */
  readonly admitted: boolean;
  readonly sensitivity: string;
  readonly taint: "clean" | "quoted";
  readonly authority: RetrievalAuthority | null;
  /** JSON array of the page's source references, as it is stored on every edge. */
  readonly provenance: string;
}

interface PageLinks {
  readonly wikilinks: readonly string[];
  readonly subjects: readonly string[];
}

const NO_LINKS: PageLinks = { wikilinks: [], subjects: [] };

function assessPage(
  page: CanonPage,
  evidence: { readonly revision: { readonly authority: RetrievalAuthority } } | undefined,
): { row: PageRow; links: PageLinks } {
  const active = isLiveCanonPage(page);
  const title = page.data["title"];
  return {
    row: {
      id: page.id,
      relPath: page.relPath,
      title: typeof title === "string" ? title : null,
      active,
      admitted: evidence !== undefined,
      sensitivity: pageSensitivity(page),
      taint: pageTaint(page),
      authority: evidence?.revision.authority ?? null,
      provenance: JSON.stringify(stringArray(page.data["sources"])),
    },
    links: active
      ? {
          wikilinks: [...new Set(wikilinks(page.body))],
          subjects: [...new Set(stringArray(page.data["subjects"]))],
        }
      : NO_LINKS,
  };
}

function sourcesOf(row: PageRow): string[] {
  return stringArray(JSON.parse(row.provenance));
}

/** Everything a projection needs to know about the pages as a set. */
interface GraphState {
  readonly rows: readonly PageRow[];
  /** Pages whose relations are withheld: held by a write, purge or recovery, or live without positive evidence. */
  readonly held: { readonly paths: Set<string>; readonly pageIds: Set<string> };
  readonly aliases: ReadonlySet<string>;
  /** False when a held page is not among the rows, so its aliases are unknown. */
  readonly complete: boolean;
  readonly withheldCount: number;
  /** Held pages stay in resolution so a link to one is withheld, not resolved to a raw title. */
  readonly index: LinkIndex;
  /** Pages that project edges, by id. */
  readonly projected: ReadonlyMap<string, PageRow>;
}

function graphState(db: Database, rows: readonly PageRow[]): GraphState {
  const held = readDerivedHolds(db, rows);
  const missing = new Set(held.paths);
  const aliases = new Set<string>();
  let withheldCount = held.paths.size;
  for (const row of rows) {
    missing.delete(row.relPath);
    // Unheld inactive pages do not resolve links or suppress ordinary prose targets.
    if (!held.paths.has(row.relPath) && (!row.active || row.admitted)) continue;
    if (!held.paths.has(row.relPath) && row.active) withheldCount += 1;
    held.paths.add(row.relPath);
    held.pageIds.add(row.id);
    for (const alias of linkKeys(row)) aliases.add(alias);
  }
  if (held.paths.size > 0 && tableExists(db, "page_index")) {
    for (const row of db.query<{ page_id: string }, [string]>(
      "SELECT page_id FROM page_index WHERE rel_path IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify([...held.paths]))) held.pageIds.add(row.page_id);
  }
  return {
    rows, held, aliases, complete: missing.size === 0, withheldCount,
    index: linkIndexFromTargets(rows.filter((row) => row.active)),
    projected: new Map(rows.filter((row) => row.active && !held.paths.has(row.relPath)).map((row) => [row.id, row])),
  };
}

function isHeldEdge(edge: StoredEdge, state: GraphState): boolean {
  return state.held.pageIds.has(edge.dst) || (edge.kind === "wikilink" && state.aliases.has(edge.dst.toLowerCase()));
}

function readRegistry(db: Database, where = "", bindings: string[] = []): PageRow[] {
  return db.query<{
    page_id: string; rel_path: string; title: string | null; active: number; admitted: number;
    sensitivity: string; taint: "clean" | "quoted"; authority: RetrievalAuthority | null; provenance: string;
  }, string[]>(`SELECT page_id, rel_path, title, active, admitted, sensitivity, taint, authority, provenance FROM graph_pages ${where}`)
    .all(...bindings).map((row) => ({
      id: row.page_id, relPath: row.rel_path, title: row.title, active: row.active === 1, admitted: row.admitted === 1,
      sensitivity: row.sensitivity, taint: row.taint, authority: row.authority, provenance: row.provenance,
    }));
}

/** Links of the named pages, or of every page. */
function readLinks(db: Database, ids?: readonly string[]): Map<string, PageLinks> {
  const rows = ids === undefined
    ? db.query<{ src: string; kind: string; target: string }, []>("SELECT src, kind, target FROM graph_links").all()
    : db.query<{ src: string; kind: string; target: string }, [string]>(
      "SELECT src, kind, target FROM graph_links WHERE src IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(ids));
  const links = new Map<string, { wikilinks: string[]; subjects: string[] }>();
  for (const { src, kind, target } of rows) {
    const entry = links.get(src) ?? { wikilinks: [], subjects: [] };
    (kind === "wikilink" ? entry.wikilinks : entry.subjects).push(target);
    links.set(src, entry);
  }
  return links;
}

function insertRow(db: Database, row: PageRow, links: PageLinks): void {
  db.query(
    `INSERT OR REPLACE INTO graph_pages
       (page_id, rel_path, title, active, admitted, sensitivity, taint, authority, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.relPath, row.title, row.active ? 1 : 0, row.admitted ? 1 : 0, row.sensitivity, row.taint, row.authority, row.provenance);
  const insert = db.query("INSERT OR IGNORE INTO graph_links (src, kind, target, key) VALUES (?, ?, ?, ?)");
  for (const target of links.wikilinks) insert.run(row.id, "wikilink", target, target.toLowerCase());
  for (const target of links.subjects) insert.run(row.id, "subject", target, target.toLowerCase());
}

/** The row for this identity replaces whatever the registry held under its id or path. */
function saveRow(db: Database, row: PageRow, links: PageLinks): void {
  removeRow(db, row.id, row.relPath);
  insertRow(db, row, links);
}

function removeRow(db: Database, id: string, relPath: string): void {
  db.query("DELETE FROM graph_links WHERE src IN (SELECT page_id FROM graph_pages WHERE page_id = ? OR rel_path = ?)").run(id, relPath);
  db.query("DELETE FROM graph_pages WHERE page_id = ? OR rel_path = ?").run(id, relPath);
}

/** Lowercase link keys of what the registry holds under this identity. */
function registeredKeys(db: Database, id: string, relPath: string): string[] {
  return readRegistry(db, "WHERE page_id = ? OR rel_path = ?", [id, relPath]).flatMap(linkKeys);
}

export function clearGraphRegistry(db: Database): void {
  for (const table of ["graph_links", "graph_pages", "graph_files", "graph_registry"]) {
    if (tableExists(db, table)) db.exec(`DELETE FROM ${table}`);
  }
}

/** True once a walk has filled the registry, so one page can be refreshed without another walk. */
export function graphRegistryReady(db: Database): boolean {
  return tableExists(db, "graph_registry") && db.query("SELECT 1 FROM graph_registry").get() !== null;
}

/**
 * True when the registry was filled from a vault that still looks the same,
 * apart from the named page: no file added, removed or rewritten since.
 */
export function graphRegistryCurrent(
  db: Database,
  signatures: ReadonlyMap<string, string>,
  page: { readonly id: string; readonly relPath?: string },
): boolean {
  if (!graphRegistryReady(db)) return false;
  const own = new Set(db.query<{ rel_path: string }, [string]>("SELECT rel_path FROM graph_pages WHERE page_id = ?")
    .all(page.id).map((row) => row.rel_path));
  if (page.relPath !== undefined) own.add(page.relPath);
  const known = new Map(db.query<{ rel_path: string; signature: string }, []>("SELECT rel_path, signature FROM graph_files")
    .all().map((row) => [row.rel_path, row.signature]));
  for (const [relPath, signature] of signatures) {
    if (!own.has(relPath) && known.get(relPath) !== signature) return false;
  }
  for (const relPath of known.keys()) {
    if (!own.has(relPath) && !signatures.has(relPath)) return false;
  }
  return true;
}

/**
 * Where the registry says the page with this id lives: a path, null when the
 * vault still matches the registry and holds no such page, undefined when only
 * a walk can tell.
 */
export function registeredPagePath(
  db: Database,
  signatures: ReadonlyMap<string, string>,
  pageId: string,
): string | null | undefined {
  if (!graphRegistryCurrent(db, signatures, { id: pageId })) return undefined;
  return db.query<{ rel_path: string }, [string]>("SELECT rel_path FROM graph_pages WHERE page_id = ?").get(pageId)?.rel_path ?? null;
}

function registrySkipped(db: Database): number {
  return db.query<{ skipped: number }, []>("SELECT skipped FROM graph_registry").get()?.skipped ?? 0;
}

/** Replace the registry with a walk's pages, assessing each one's evidence. */
function syncRegistry(
  db: Database,
  pages: readonly CanonPage[],
  skipped: number,
  signatures: ReadonlyMap<string, string> = new Map(),
): GraphState {
  const evidence = projectablePageEvidence(db, pages);
  clearGraphRegistry(db);
  for (const [relPath, signature] of signatures) {
    db.query("INSERT INTO graph_files (rel_path, signature) VALUES (?, ?)").run(relPath, signature);
  }
  const rows = pages.map((page) => {
    const assessed = assessPage(page, evidence.get(page.relPath));
    insertRow(db, assessed.row, assessed.links);
    return assessed.row;
  });
  db.query("INSERT INTO graph_registry (singleton, skipped) VALUES (1, ?)").run(skipped);
  return graphState(db, rows);
}

function insertEdge(db: Database, edge: StoredEdge): void {
  db.query<
    never,
    [string, string, GraphEdgeKind, string, string | null, string, string, string]
  >(
    `INSERT OR IGNORE INTO graph_edges
       (src, dst, kind, sensitivity, dest_sensitivity, taint, authority, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    edge.src,
    edge.dst,
    edge.kind,
    edge.sensitivity,
    edge.dest_sensitivity,
    edge.taint,
    edge.authority,
    edge.provenance,
  );
}

function pageEdges(
  row: PageRow,
  links: PageLinks,
  state: GraphState,
  eventHints: ReadonlyMap<string, string>,
): StoredEdge[] {
  const edges: StoredEdge[] = [];
  const seen = new Set<string>();
  const push = (dst: string, kind: GraphEdgeKind) => {
    const key = `${dst}\u0000${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      src: row.id,
      dst,
      kind,
      sensitivity: row.sensitivity,
      dest_sensitivity: destSensitivity(kind, dst, state.projected, eventHints),
      taint: row.taint,
      authority: row.authority!,
      provenance: row.provenance,
    });
  };
  for (const target of links.wikilinks) {
    push(resolveWikilink(state.index, target) ?? target, "wikilink");
  }
  for (const subject of links.subjects) {
    push(subject, "subject");
  }
  for (const source of sourcesOf(row)) {
    push(source, "source");
  }
  return edges;
}

/** Write the edges of the named pages that project, from the registry alone. */
function projectPages(db: Database, state: GraphState, ids: readonly string[]): void {
  const rows = ids.flatMap((id) => state.projected.get(id) ?? []);
  const links = readLinks(db, ids);
  const eventHints = eventSensitivityHints(db, [...new Set(rows.flatMap(sourcesOf).map(bareRetrievalId))]);
  for (const row of rows) {
    for (const edge of pageEdges(row, links.get(row.id) ?? NO_LINKS, state, eventHints)) {
      if (!isHeldEdge(edge, state)) insertEdge(db, edge);
    }
  }
}

/** Project every page's edges. Same write as a graph rebuild. */
function projectAll(db: Database, state: GraphState): void {
  db.exec("DELETE FROM graph_edges");
  // A missing held page leaves its title aliases unknown. Withhold this
  // projection until a complete page snapshot can exclude those relations.
  if (state.complete) projectPages(db, state, [...state.projected.keys()]);
  markDerivedHeld(db, "graph", state.withheldCount);
}

/** The pages whose edges may change when this identity changes: those linking by one of its names. */
function affectedPages(db: Database, keys: readonly string[], pageId: string): string[] {
  return db.query<{ src: string }, [string, string]>(
    `SELECT src FROM graph_links WHERE key IN (SELECT value FROM json_each(?))
     UNION SELECT src FROM graph_edges WHERE dst = ?`,
  ).all(JSON.stringify(keys), pageId).map((row) => row.src);
}

/** Re-project one page and every page whose links to it would resolve differently now. */
function projectAffected(db: Database, state: GraphState, keys: readonly string[], pageId: string): void {
  const ids = [...new Set([pageId, ...affectedPages(db, keys, pageId)])];
  db.query("DELETE FROM graph_edges WHERE src IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
  projectPages(db, state, ids);
}

/** Only this page's own edges. Relations into a page that does not project are dropped, not re-resolved. */
function projectOne(db: Database, state: GraphState, pageId: string): void {
  db.query("DELETE FROM graph_edges WHERE src = ?").run(pageId);
  if (state.projected.has(pageId)) projectPages(db, state, [pageId]);
  else db.query("DELETE FROM graph_edges WHERE dst = ?").run(pageId);
}

function removeHeldEdges(db: Database, state: GraphState): void {
  if (state.held.paths.size === 0) return;
  if (!state.complete) {
    db.exec("DELETE FROM graph_edges");
    return;
  }
  const ids = JSON.stringify([...state.held.pageIds]);
  db.query(`DELETE FROM graph_edges
             WHERE src IN (SELECT value FROM json_each(?))
                OR dst IN (SELECT value FROM json_each(?))
                OR (kind='wikilink' AND lower(dst) IN (SELECT value FROM json_each(?)))`)
    .run(ids, ids, JSON.stringify([...state.aliases]));
}

/** Remove existing held relations without projecting any new page content. */
export function removeHeldPageEdges(db: Database, pages: readonly CanonPage[]): void {
  const evidence = projectablePageEvidence(db, pages);
  const state = graphState(db, pages.map((page) => assessPage(page, evidence.get(page.relPath)).row));
  removeHeldEdges(db, state);
  markDerivedHeld(db, "graph", state.withheldCount);
  // The registry would keep the erased evidence's references and now disagrees with the edges.
  clearGraphRegistry(db);
}

function stampGraphIncomplete(db: Database, skippedCount: number, withheldCount: number): void {
  const existing = readDerivedMeta(db, "graph");
  stampDerived(db, {
    layer: "graph",
    generation: existing?.generation ?? ulid(),
    rebuilt_at: new Date().toISOString(),
    doc_count: existing?.doc_count ?? 0,
    source_count: existing?.source_count ?? 0,
    skipped_count: skippedCount + withheldCount,
    status: "degraded",
    ledger_watermark: existing?.ledger_watermark ?? null,
    canon_hash: withheldCount > 0 ? null : existing?.canon_hash ?? null,
    port_id: existing?.port_id ?? null,
    contract: existing?.contract ?? null,
    space: existing?.space ?? null,
  });
}

function restoreGraphStamp(db: Database, state: GraphState): void {
  const existing = readDerivedMeta(db, "graph");
  if (state.withheldCount === 0 && (existing === null || existing.status === "ok")) return;
  const live = [...state.projected.values()];
  const edges =
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM graph_edges",
      )
      .get()?.count ?? 0;
  stampDerived(
    db,
    stampGraph(
      db,
      {
        generation: ulid(),
        pages: [],
        skipped: [],
        rebuilt_at: new Date().toISOString(),
        canon_hash: canonPagesHash(live),
      },
      live.length,
      edges,
      state.withheldCount,
    ),
  );
}

/**
 * Bring the projection up to date after one page changed; `keys` are the names
 * other pages may have linked to it by before the change. Without a change,
 * every page is projected again. After a complete walk the pages linking to
 * the changed page are projected again with it. A walk that skipped files
 * keeps every other page's edges until the next complete walk.
 */
function settleGraph(
  db: Database,
  state: GraphState,
  skipped: number,
  change: { readonly pageId: string; readonly keys: readonly string[] } | null,
): void {
  if (!state.complete) {
    db.exec("DELETE FROM graph_edges");
    stampGraphIncomplete(db, skipped, state.withheldCount);
    return;
  }
  removeHeldEdges(db, state);
  if (change === null) projectAll(db, state);
  else if (skipped === 0) projectAffected(db, state, change.keys, change.pageId);
  else projectOne(db, state, change.pageId);
  if (skipped === 0) restoreGraphStamp(db, state);
  else stampGraphIncomplete(db, skipped, state.withheldCount);
}

/** Project every live page's edges from a walk. */
export function replacePageEdges(
  db: Database,
  pages: readonly CanonPage[],
  signatures?: ReadonlyMap<string, string>,
): void {
  assertDerivedDiscoveryReady(db);
  projectAll(db, syncRegistry(db, pages, 0, signatures));
}

/**
 * Incremental graph write from a walk. A complete walk projects the live set;
 * otherwise only this page and the pages that link to it are projected again.
 */
export function refreshPageEdges(
  db: Database,
  page: CanonPage,
  pages: readonly CanonPage[],
  skipped: number,
  signatures?: ReadonlyMap<string, string>,
): void {
  assertDerivedDiscoveryReady(db);
  const before = graphRegistryReady(db) ? registeredKeys(db, page.id, page.relPath) : [];
  const state = syncRegistry(db, [...pages.filter(candidate => candidate.relPath !== page.relPath), page], skipped, signatures);
  const row = state.rows.find((candidate) => candidate.id === page.id)!;
  settleGraph(db, state, skipped, skipped === 0 ? null : { pageId: page.id, keys: [...before, ...linkKeys(row)] });
}

/** Incremental delete from a walk. An incomplete walk projects only the pages that linked to it again. */
export function removePageEdges(
  db: Database,
  pageId: string,
  pages: readonly CanonPage[],
  skipped: number,
  signatures?: ReadonlyMap<string, string>,
): void {
  assertDerivedDiscoveryReady(db);
  const before = graphRegistryReady(db) ? registeredKeys(db, pageId, "") : [];
  const state = syncRegistry(db, pages, skipped, signatures);
  settleGraph(db, state, skipped, skipped === 0 ? null : { pageId, keys: before });
}

/**
 * Refresh one page from the registry a walk filled earlier: only this page's
 * evidence is assessed, and only it and the pages linking to it are projected
 * again. Callers check `graphRegistryReady` first.
 */
export function refreshRegisteredPage(db: Database, page: CanonPage, signatures: ReadonlyMap<string, string>): void {
  assertDerivedDiscoveryReady(db);
  const before = registeredKeys(db, page.id, page.relPath);
  const assessed = assessPage(page, projectablePageEvidence(db, [page]).get(page.relPath));
  saveRow(db, assessed.row, assessed.links);
  db.query("DELETE FROM graph_files WHERE rel_path IN (SELECT rel_path FROM graph_pages WHERE page_id = ?)").run(page.id);
  const signature = signatures.get(page.relPath);
  if (signature !== undefined) db.query("INSERT OR REPLACE INTO graph_files (rel_path, signature) VALUES (?, ?)").run(page.relPath, signature);
  settleGraph(db, graphState(db, readRegistry(db)), registrySkipped(db), {
    pageId: page.id,
    keys: [...before, ...linkKeys(assessed.row)],
  });
}

/** Incremental delete from the registry. Callers check `graphRegistryReady` first. */
export function removeRegisteredPage(db: Database, pageId: string): void {
  assertDerivedDiscoveryReady(db);
  const before = registeredKeys(db, pageId, "");
  db.query("DELETE FROM graph_files WHERE rel_path IN (SELECT rel_path FROM graph_pages WHERE page_id = ?)").run(pageId);
  removeRow(db, pageId, "");
  settleGraph(db, graphState(db, readRegistry(db)), registrySkipped(db), { pageId, keys: before });
}

function stampGraph(
  db: Database,
  input: GraphRebuildInput,
  pages: number,
  edges: number,
  withheld = readDerivedHolds(db).paths.size,
): DerivedStamp {
  const watermark = latestLedgerCursor(db);
  return {
    layer: "graph",
    generation: input.generation,
    rebuilt_at: input.rebuilt_at,
    doc_count: edges,
    source_count: pages,
    skipped_count: input.skipped.length + withheld,
    status: input.skipped.length + withheld > 0 ? "degraded" : "ok",
    ledger_watermark:
      watermark === null
        ? null
        : `${watermark.accepted_at}\t${watermark.event_id}`,
    canon_hash: withheld > 0 ? null : input.canon_hash,
    port_id: null,
    contract: "kizuki.retrieval/v1",
    space: null,
  };
}

function snapshotGraphInput(vaultPath: string): GraphRebuildInput {
  const report = listCanonPagesReport(vaultPath);
  const live = report.pages.filter(isLiveCanonPage);
  return {
    generation: ulid(),
    pages: report.pages,
    skipped: report.skipped,
    signatures: report.signatures,
    rebuilt_at: new Date().toISOString(),
    canon_hash: canonPagesHash(live),
  };
}

/** Rebuild the graph layer. Caller owns the transaction. */
export function rebuildGraphLayer(
  db: Database,
  input: GraphRebuildInput,
): GraphRebuildResult {
  assertDerivedDiscoveryReady(db);
  const state = syncRegistry(db, input.pages, input.skipped.length, input.signatures);
  projectAll(db, state);
  const edges =
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM graph_edges",
      )
      .get()?.count ?? 0;
  stampDerived(db, stampGraph(db, input, state.projected.size, edges, state.withheldCount));
  return {
    pages: state.projected.size,
    edges,
    skipped: [...input.skipped],
    rebuilt_at: input.rebuilt_at,
    generation: input.generation,
    status: input.skipped.length + state.withheldCount > 0 ? "degraded" : "ok",
  };
}

export function rebuildGraph(
  db: Database,
  vaultPathOrInput: string | GraphRebuildInput,
): GraphRebuildResult {
  initGraph(db);
  const input =
    typeof vaultPathOrInput === "string"
      ? snapshotGraphInput(vaultPathOrInput)
      : vaultPathOrInput;
  return db.transaction(() => rebuildGraphLayer(db, input)).immediate();
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function incidentEdges(
  db: Database,
  ids: string[],
  kinds: GraphEdgeKind[] | undefined,
  ceiling: Sensitivity | undefined,
  remaining: number,
): GraphEdge[] {
  if (ids.length === 0 || kinds?.length === 0 || remaining <= 0) return [];
  const collected: GraphEdge[] = [];
  for (const group of chunks(ids, FRONTIER_CHUNK)) {
    if (collected.length >= remaining) break;
    const idSlots = placeholders(group.length);
    const bindings: (string | number)[] = [...group, ...group];
    const extra: string[] = [];
    if (kinds !== undefined) {
      extra.push(`kind IN (${placeholders(kinds.length)})`);
      bindings.push(...kinds);
    }
    if (ceiling !== undefined) {
      extra.push(`sensitivity != 'unlabeled'`);
      extra.push(`${sensitivityRankSql("sensitivity")} <= ?`);
      extra.push(
        `(dest_sensitivity IS NULL OR (dest_sensitivity != 'unlabeled' AND ${sensitivityRankSql("dest_sensitivity")} <= ?))`,
      );
      bindings.push(SENSITIVITY_ORDER[ceiling], SENSITIVITY_ORDER[ceiling]);
    }
    const extraSql = extra.length === 0 ? "" : ` AND ${extra.join(" AND ")}`;
    bindings.push(remaining - collected.length);
    collected.push(
      ...db
        .query<GraphEdge, (string | number)[]>(
          `SELECT src, dst, kind FROM graph_edges
           WHERE (src IN (${idSlots}) OR dst IN (${idSlots}))${extraSql}
           ORDER BY src, dst, kind
           LIMIT ?`,
        )
        .all(...bindings),
    );
  }
  return collected;
}

function sensitivityRankSql(column: string): string {
  return `CASE ${column} WHEN 'public' THEN 0 WHEN 'personal' THEN 1 WHEN 'private' THEN 2 ELSE 99 END`;
}

function validLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > MAX_RETRIEVAL_LIMIT
  ) {
    throw new RangeError(
      `neighbors limit must be an integer between 0 and ${MAX_RETRIEVAL_LIMIT}`,
    );
  }
  return limit;
}

export function neighbors(
  db: Database,
  id: string,
  opts: NeighborOptions = {},
): NeighborResult {
  const depth = opts.depth ?? 1;
  if (depth !== 1 && depth !== 2) {
    throw new RangeError("neighbors depth must be 1 or 2");
  }
  const limit = validLimit(opts.limit ?? MAX_RETRIEVAL_LIMIT);
  if (limit === 0 || opts.kinds?.length === 0) {
    return { id, edges: [], truncated: false };
  }
  if (!tableExists(db, "graph_edges")) {
    return { id, edges: [], truncated: false };
  }

  const seenNodes = new Set([id]);
  const seenEdges = new Set<string>();
  const result: GraphEdge[] = [];
  let frontier = [id];
  let truncated = false;

  for (let level = 0; level < depth && !truncated; level += 1) {
    const available = incidentEdges(
      db,
      frontier,
      opts.kinds,
      opts.ceiling,
      limit + 1,
    );
    const next: string[] = [];
    const frontierNodes = new Set(frontier);
    for (const edge of available) {
      const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      if (result.length === limit) {
        truncated = true;
        break;
      }
      result.push(edge);
      const adjacent = frontierNodes.has(edge.src) ? edge.dst : edge.src;
      if (!seenNodes.has(adjacent)) {
        seenNodes.add(adjacent);
        next.push(adjacent);
      }
    }
    frontier = next;
  }

  result.sort(
    (a, b) =>
      compareText(a.src, b.src) ||
      compareText(a.dst, b.dst) ||
      compareText(a.kind, b.kind),
  );
  return { id, edges: result, truncated };
}
