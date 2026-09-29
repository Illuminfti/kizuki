import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDaemonBriefPath } from "../canon/origin";
import { PortError } from "../contracts/ports";
import { countUnwrittenLiveClaims } from "../claims/store";
import { tableExists } from "../ledger/schema";
import { parseFrontmatter, serializePage } from "../vault/frontmatter";
import { parsePageSources, validatePage } from "../vault/schema";
import { readExtractCursor } from "./extract";
import { createFileNotifier } from "./notifier-file";
import { parseRunReceipt } from "./receipts";

/** Most pages one list names; the count above it stays exact. */
const LIST_LIMIT = 10;
const RAIL_GROUP_LIMIT = 10;
const DETAIL_CHARS = 160;
const DAY_MS = 86_400_000;

interface CanonChange {
  readonly label: string;
  /** Distinct pages, exact. */
  readonly pages: number;
  /** Most recent first, at most `LIST_LIMIT`. */
  readonly listed: readonly string[];
}

interface RailProblem {
  readonly rail: string;
  readonly status: string;
  readonly runs: number;
  readonly last_at: string;
  readonly detail: string | null;
}

interface BriefFacts {
  readonly since: string;
  readonly until: string;
  readonly changes: readonly CanonChange[];
  readonly problems: readonly RailProblem[];
  readonly unwritten_claims: number;
  readonly events_past_cursor: number;
  readonly deferred_inputs: number;
  readonly new_events: number;
}

/** Receipt categories, in the order the brief reports them. `revert` receipts are undo. */
const CHANGE_SQL: readonly {
  readonly label: string;
  readonly where: string;
}[] = [
  {
    label: "New pages",
    where:
      "receipt_kind <> 'revert' AND writer <> 'correction' AND page_action = 'create'",
  },
  {
    label: "Updated pages",
    where:
      "receipt_kind <> 'revert' AND writer <> 'correction' AND page_action <> 'create'",
  },
  {
    label: "Corrected pages",
    where: "receipt_kind <> 'revert' AND writer = 'correction'",
  },
  { label: "Undone writes", where: "receipt_kind = 'revert'" },
];

function instant(value: string): string {
  return new Date(value).toISOString();
}

/**
 * The brief covers everything since the previous day's brief, so a second run
 * on the same day rewrites the same window instead of shrinking it. With no
 * earlier brief it covers the day before `until`.
 */
function windowStart(db: Database, day: string, until: string): string {
  if (tableExists(db, "run_receipts")) {
    const previous = db
      .query<{ started_at: string }, [string]>(
        `SELECT started_at FROM run_receipts
          WHERE rail = 'brief' AND status = 'ok' AND substr(started_at, 1, 10) < ?
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(day);
    if (previous !== null) return instant(previous.started_at);
  }
  return new Date(Date.parse(until) - DAY_MS).toISOString();
}

function canonChanges(
  db: Database,
  since: string,
  until: string,
): CanonChange[] {
  if (!tableExists(db, "canon_receipts")) return [];
  return CHANGE_SQL.map(({ label, where }) => {
    const range = `at > ? AND at <= ? AND ${where}`;
    const pages =
      db
        .query<{ n: number }, [string, string]>(
          `SELECT count(DISTINCT page_path) AS n FROM canon_receipts WHERE ${range}`,
        )
        .get(since, until)?.n ?? 0;
    const listed = db
      .query<{ page_path: string }, [string, string, number]>(
        `SELECT page_path FROM canon_receipts WHERE ${range}
          GROUP BY page_path ORDER BY max(at) DESC, page_path LIMIT ?`,
      )
      .all(since, until, LIST_LIMIT)
      .map((row) => row.page_path);
    return { label, pages, listed };
  });
}

function railProblems(
  db: Database,
  since: string,
  until: string,
): RailProblem[] {
  if (!tableExists(db, "run_receipts")) return [];
  const groups = db
    .query<
      { rail: string; status: string; runs: number; last_at: string },
      [string, string, number]
    >(
      `SELECT rail, status, count(*) AS runs, max(finished_at) AS last_at FROM run_receipts
        WHERE finished_at > ? AND finished_at <= ? AND status <> 'ok'
        GROUP BY rail, status ORDER BY runs DESC, rail, status LIMIT ?`,
    )
    .all(since, until, RAIL_GROUP_LIMIT);
  return groups.map((group) => {
    const row = db
      .query<{ report: string }, [string, string, string]>(
        "SELECT report FROM run_receipts WHERE rail = ? AND status = ? AND finished_at = ? LIMIT 1",
      )
      .get(group.rail, group.status, group.last_at);
    let detail: string | null = null;
    try {
      const receipt =
        row === null ? null : parseRunReceipt(JSON.parse(row.report));
      detail = receipt?.errors[0] ?? receipt?.stopped ?? null;
    } catch {
      detail = null;
    }
    return { ...group, detail };
  });
}

function count(db: Database, sql: string, ...bindings: string[]): number {
  return db.query<{ n: number }, string[]>(sql).get(...bindings)?.n ?? 0;
}

/** Events after the extraction cursor, the ledger's own order: accepted_at, then id. */
function eventsPastCursor(db: Database): number {
  if (!tableExists(db, "events")) return 0;
  const cursor = tableExists(db, "rail_cursors") ? readExtractCursor(db) : null;
  const split = cursor === null ? -1 : cursor.indexOf("\t");
  if (cursor === null || split <= 0 || split === cursor.length - 1) {
    return count(db, "SELECT count(*) AS n FROM events");
  }
  const acceptedAt = cursor.slice(0, split);
  return count(
    db,
    "SELECT count(*) AS n FROM events WHERE accepted_at > ? OR (accepted_at = ? AND event_id > ?)",
    acceptedAt,
    acceptedAt,
    cursor.slice(split + 1),
  );
}

function gatherFacts(db: Database, now: string): BriefFacts {
  const until = instant(now);
  const since = windowStart(db, until.slice(0, 10), until);
  return {
    since,
    until,
    changes: canonChanges(db, since, until),
    problems: railProblems(db, since, until),
    unwritten_claims: countUnwrittenLiveClaims(db),
    events_past_cursor: eventsPastCursor(db),
    deferred_inputs: tableExists(db, "extract_deferred_inputs")
      ? count(db, "SELECT count(*) AS n FROM extract_deferred_inputs")
      : 0,
    new_events: tableExists(db, "events")
      ? count(
          db,
          "SELECT count(*) AS n FROM events WHERE accepted_at > ? AND accepted_at <= ?",
          since,
          until,
        )
      : 0,
  };
}

/** One line of untrusted or receipt text: no markup, no line breaks, bounded. */
function inline(text: string): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > DETAIL_CHARS
    ? `${flat.slice(0, DETAIL_CHARS - 3)}...`
    : flat;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function briefBody(
  day: string,
  facts: BriefFacts,
  modelRef: string | null,
): string {
  const lines: string[] = [
    `# Brief ${day}`,
    "",
    `Covers ${facts.since} to ${facts.until}.`,
    "",
  ];

  lines.push("## Canon");
  const changed = facts.changes.filter((change) => change.pages > 0);
  if (changed.length === 0)
    lines.push(
      "- No canon page was created, updated, corrected or undone in this window.",
    );
  for (const change of changed) {
    lines.push(`- ${change.label}: ${change.pages}`);
    for (const path of change.listed) lines.push(`  - \`${inline(path)}\``);
    if (change.pages > change.listed.length)
      lines.push(`  - and ${change.pages - change.listed.length} more`);
  }

  lines.push("", "## Rails");
  if (facts.problems.length === 0)
    lines.push("- Every rail run in this window finished ok.");
  for (const problem of facts.problems) {
    const detail = problem.detail === null ? "" : `: ${inline(problem.detail)}`;
    lines.push(
      `- ${inline(problem.rail)} ${inline(problem.status)} in ${plural(problem.runs, "run", "runs")}, last ${problem.last_at}${detail}`,
    );
  }

  lines.push(
    "",
    "## Backlog",
    `- Live claims not yet written to canon: ${facts.unwritten_claims}`,
    `- Ledger events past the extraction cursor: ${facts.events_past_cursor}`,
    `- Deferred extraction inputs: ${facts.deferred_inputs}`,
    "",
    "## State",
    `- Canon writing: ${modelRef === null || modelRef === "" ? "off (no model configured; connectors, ledger, search, timeline and undo still work)" : `on (${inline(modelRef)})`}`,
    `- New ledger events in this window: ${facts.new_events}`,
    "",
    "The loop writes canon. There is no review queue.",
    "Correction is `kizuki tell` / MCP `correct`. Audit and undo stay in the TUI.",
    "",
  );
  return lines.join("\n");
}

function briefData(day: string): Record<string, string | string[]> {
  return {
    id: `rollup:brief-${day}`,
    title: `Daily brief ${day}`,
    type: "rollup",
    status: "active",
    sensitivity: "personal",
    taint: "clean",
    // Rendered from rail and canon state, not from ledger events: the honest
    // provenance is an explicit empty list, declared in `parsePageSources`.
    sources: [],
    "x-brief-producer": "deterministic",
  };
}

/** The whole page for `day`, summarising what changed since the previous day's brief. */
export function composeBrief(
  db: Database,
  now: string,
  modelRef: string | null,
): string {
  const day = now.slice(0, 10);
  return serializePage({
    data: briefData(day),
    body: briefBody(day, gatherFacts(db, now), modelRef),
  });
}

export interface BriefRepair {
  /** Pages rewritten to pass the page schema. */
  readonly repaired: number;
  /** Pages that needed it and could not be rewritten; the next sweep tries again. */
  readonly failed: number;
}

/**
 * Rewrites daemon-written brief pages that fail the page schema (an older
 * build omitted `sources`) through the same notifier that wrote them, keeping
 * their body. A page the daemon did not write, or whose frontmatter cannot be
 * read at all, is left for its owner. A busy canon writer defers the page to
 * the next sweep; any other refusal is counted as failed.
 */
export async function repairBriefPages(vaultPath: string): Promise<BriefRepair> {
  const directory = join(vaultPath, "dashboards");
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return { repaired: 0, failed: 0 };
  }
  const notifier = createFileNotifier(vaultPath);
  let repaired = 0;
  let failed = 0;
  for (const name of names) {
    if (!isDaemonBriefPath(`dashboards/${name}`)) continue;
    const day = name.slice("brief-".length, -".md".length);
    let page: ReturnType<typeof parseFrontmatter>;
    try {
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) continue;
      page = parseFrontmatter(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (page.data["id"] !== `rollup:brief-${day}`) continue;
    if (validatePage(page.data).length === 0 && parsePageSources(page.data).ok) continue;
    try {
      await notifier.notify({
        notification_id: day,
        title: `brief:${day}`,
        body: serializePage({ data: briefData(day), body: page.body }),
        sensitivity: "personal",
        provenance: [],
      });
      repaired += 1;
    } catch (error) {
      if (!(error instanceof PortError && error.retryable)) failed += 1;
    }
  }
  return { repaired, failed };
}
