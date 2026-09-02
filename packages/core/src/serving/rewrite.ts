import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, resolveTarget } from "../canon";
import type { CanonIo, PageAction } from "../canon";
import type { Claim } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { diffLines } from "../util/diff";
import type { ServeContext } from "./types";

/**
 * RFC 0002 §6.3 step 5 bounds the blast radius of one correction. The writer
 * binds one receipt to one claim, so a single pass rewrites the page the
 * arbiter resolves; any further page bound to a retired claim is named in the
 * answer rather than silently left out.
 */
export const CORRECTION_MAX_PAGES = 25;
/** Enough of a rewrite to read; a page is on disk for the whole of it. */
const MAX_DIFF_LINES = 200;

export interface RewrittenPage {
  page_path: string;
  page_action: PageAction;
  before_hash: string | null;
  after_hash: string;
  receipt_id: string;
  diff: string;
}

export interface CanonRewrite {
  receipt_id: string | null;
  rewritten: RewrittenPage[];
  /** Pages a retired claim is bound to that this pass did not reach. */
  unreached: string[];
  /** Set when the rewrite could not run; the claim itself still stands. */
  failed: boolean;
}

const NOTHING: CanonRewrite = {
  receipt_id: null,
  rewritten: [],
  unreached: [],
  failed: false,
};

function canonIo(ctx: ServeContext): CanonIo {
  return { db: ctx.db, vault_path: ctx.vaultPath };
}

function pageText(ctx: ServeContext, relPath: string): string {
  const path = join(ctx.vaultPath, relPath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** A unified body, truncated by line count so one page cannot flood a reply. */
function unified(relPath: string, before: string, after: string): string {
  const lines = diffLines(before, after);
  const shown = lines.slice(0, MAX_DIFF_LINES).map((line) => {
    const mark = line.op === "add" ? "+" : line.op === "del" ? "-" : " ";
    return `${mark}${line.text}`;
  });
  if (lines.length > MAX_DIFF_LINES) {
    shown.push(`@@ ${lines.length - MAX_DIFF_LINES} more line(s) @@`);
  }
  return [`--- ${relPath}`, `+++ ${relPath}`, ...shown].join("\n");
}

/** Pages a superseded claim's key is bound to, oldest binding first. */
function boundPages(ctx: ServeContext, claimKeys: string[]): string[] {
  if (claimKeys.length === 0 || !tableExists(ctx.db, "page_index")) return [];
  const placeholders = claimKeys.map(() => "?").join(", ");
  return ctx.db
    .query<{ rel_path: string }, [...string[], number]>(
      `SELECT DISTINCT p.rel_path AS rel_path
         FROM claim_bindings b JOIN page_index p ON p.page_id = b.page_id
        WHERE b.claim_key IN (${placeholders})
        ORDER BY p.rel_path LIMIT ?`,
    )
    .all(...claimKeys, CORRECTION_MAX_PAGES)
    .map((row) => row.rel_path);
}

/**
 * The correction and the canon rewrite in one pass (RFC 0002 §6.3). The claim
 * is already durable when this runs: a writer failure degrades the answer and
 * is reported, because rolling back an authoritative claim to keep a page in
 * step would lose the owner's own words.
 */
export function rewriteCanon(
  ctx: ServeContext,
  claim: Claim,
  supersededKeys: string[],
): CanonRewrite {
  const io = canonIo(ctx);
  const budget = createBudgetTracker({
    canon_writes_per_run: CORRECTION_MAX_PAGES,
  });
  const bound = boundPages(ctx, supersededKeys);

  try {
    const decision = resolveTarget(io, claim);
    // A correction rewrites what exists. It never mints a page for a reading
    // nothing ever materialized: that claim is the writer's own work.
    if (decision.action === "skip" || decision.action === "create") {
      return { ...NOTHING, unreached: bound };
    }
    const relPath =
      decision.action === "conflict"
        ? decision.chosen.rel_path
        : decision.rel_path;
    const before = pageText(ctx, relPath);
    const receipt = applyCanonWrite(io, claim, decision, {
      writer: "correction",
      budget,
    });
    const after = pageText(ctx, receipt.page_path);
    return {
      receipt_id: receipt.receipt_id,
      rewritten: [
        {
          page_path: receipt.page_path,
          page_action: receipt.page_action,
          before_hash: receipt.before_hash,
          after_hash: receipt.after_hash,
          receipt_id: receipt.receipt_id,
          diff: unified(receipt.page_path, before, after),
        },
      ],
      unreached: bound.filter((path) => path !== receipt.page_path),
      failed: false,
    };
  } catch {
    // The cause stays inside core; the caller learns the pages did not move.
    return { ...NOTHING, unreached: bound, failed: true };
  }
}
