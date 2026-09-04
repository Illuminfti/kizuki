import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listAuditReceipts, listCanonPagesReport, listCanonReceipts, undoReceipt } from "@kizuki/core";
import type { AuditReceipt, CanonIo } from "@kizuki/core";
import { parseFrontmatter } from "@kizuki/core";
import { colorsEnabled, paint, sanitize, truncate } from "./ansi";
import type { Key } from "./keys";
import { applyItems, initialState, reduce, withNotice } from "./model";
import type { AuditItem, AuditState, Effect, Notice } from "./model";
import { createTerminal } from "./terminal";
import type { Terminal } from "./terminal";
import { render, viewportFor } from "./view";
import { editInEditor, pickEditor } from "./editor";

export interface AuditOptions {
  db: Database;
  vaultPath: string;
  terminal?: Terminal;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface AuditSummary {
  undone: number;
}

export const PAGE_SIZE = 200;

const EMPTY_PAGE_HASH = new Bun.CryptoHasher("sha256").update(new Uint8Array()).digest("hex");

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable page";
}

function readBody(
  vaultPath: string,
  relPath: string | null,
): { body: string | null; error: string | null } {
  if (relPath === null) return { body: null, error: null };
  const path = join(vaultPath, relPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { body: null, error: null };
    return { body: null, error: `unreadable page: ${readError(error)}` };
  }
  try {
    return { body: parseFrontmatter(raw).body, error: null };
  } catch (error) {
    return { body: raw, error: `unreadable page: ${readError(error)}` };
  }
}

function titleOf(receipt: AuditReceipt, currentBody: string | null): string {
  if (currentBody !== null) {
    const first = sanitize(currentBody)
      .split("\n")
      .find((line) => line.trim().length > 0);
    if (first !== undefined) return truncate(first.trim(), 80);
  }
  return sanitize(receipt.page_path);
}

function pageHash(path: string): string | null {
  try {
    return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? EMPTY_PAGE_HASH : null;
  }
}

/** This receipt's after bytes, not whatever the page later became. */
function afterBody(
  vaultPath: string,
  receipt: AuditReceipt,
  db?: Database,
): { body: string | null; error: string | null } {
  const path = join(vaultPath, receipt.page_path);
  if (pageHash(path) === receipt.after_hash) {
    return readBody(vaultPath, receipt.page_path);
  }
  if (db === undefined) return { body: null, error: null };
  // Immediate successor, including reverted writes: their archive is this after-image.
  const next = listCanonReceipts(db, {
    page_path: receipt.page_path,
    newest_first: false,
    limit: 10_000,
  }).find(
    (row) =>
      row.at > receipt.at || (row.at === receipt.at && row.receipt_id > receipt.receipt_id),
  );
  if (next === undefined || next.archive_path === null) return { body: null, error: null };
  return readBody(vaultPath, next.archive_path);
}

export function toAuditItem(
  vaultPath: string,
  receipt: AuditReceipt,
  db?: Database,
): AuditItem {
  const current = afterBody(vaultPath, receipt, db);
  const prior = readBody(vaultPath, receipt.archive_path);
  const loadError = current.error ?? prior.error;
  return {
    receipt,
    title: titleOf(receipt, current.body ?? prior.body),
    priorBody: prior.body,
    currentBody: current.body,
    loadError,
  };
}

export interface LoadPage {
  items: AuditItem[];
  offset: number;
  truncated: boolean;
  health: Notice | null;
}

function vaultHealth(vaultPath: string): Notice | null {
  const report = listCanonPagesReport(vaultPath);
  const first = report.skipped[0];
  if (first === undefined) return null;
  const extra = report.skipped.length - 1;
  const detail = extra > 0 ? `${first.relPath} (+${extra} more)` : first.relPath;
  return {
    text: `${report.skipped.length} unreadable or duplicate canon page(s) (${detail}); run kizuki doctor`,
    tone: "error",
  };
}

export function loadItems(db: Database, vaultPath: string, offset = 0): LoadPage {
  const start = Math.max(0, offset);
  const rows = listAuditReceipts(db, { limit: PAGE_SIZE + 1, offset: start });
  const truncated = rows.length > PAGE_SIZE;
  const page = truncated ? rows.slice(0, PAGE_SIZE) : rows;
  return {
    items: page.map((receipt) => toAuditItem(vaultPath, receipt, db)),
    offset: start,
    truncated,
    health: vaultHealth(vaultPath),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAudit(opts: AuditOptions): Promise<AuditSummary> {
  const terminal = opts.terminal ?? createTerminal();
  if (!terminal.isTTY) {
    throw new Error("kizuki audit needs an interactive terminal; use `kizuki audit --json`");
  }
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const p = paint(colorsEnabled(env, true));
  const vaultName = basename(opts.vaultPath);
  const io: CanonIo = { db: opts.db, vault_path: opts.vaultPath };

  const first = loadItems(opts.db, opts.vaultPath, 0);
  let state: AuditState = initialState({
    vaultName,
    today: now().toISOString().slice(0, 10),
    items: first.items,
    health: first.health,
    pageOffset: first.offset,
    pageSize: PAGE_SIZE,
    pageTruncated: first.truncated,
  });

  const draw = (): void => {
    const { cols, rows } = terminal.size();
    terminal.draw(render(state, { cols, rows, paint: p }));
  };

  const reload = (offset = state.pageOffset): void => {
    const loaded = loadItems(opts.db, opts.vaultPath, offset);
    state = applyItems(state, loaded.items, {
      offset: loaded.offset,
      truncated: loaded.truncated,
      health: loaded.health,
    });
  };

  const runEffect = async (effect: Effect): Promise<boolean> => {
    switch (effect.type) {
      case "quit":
        return true;
      case "filter":
        return false;
      case "page":
        reload(effect.offset);
        return false;
      case "open": {
        const editor = pickEditor(env);
        if (editor === null) {
          state = withNotice(state, { text: "no editor found: set $EDITOR", tone: "error" });
          return false;
        }
        const path = join(opts.vaultPath, effect.path);
        if (!existsSync(path)) {
          state = withNotice(state, { text: "page is not on disk", tone: "warn" });
          return false;
        }
        try {
          terminal.suspend(() => editInEditor(editor, readFileSync(path, "utf8"), "audit"));
        } catch (error) {
          state = withNotice(state, { text: `open aborted: ${errorText(error)}`, tone: "error" });
        }
        return false;
      }
      case "undo": {
        const disk = pageHash(join(opts.vaultPath, effect.pagePath));
        if (disk !== effect.afterHash) {
          state = withNotice(state, {
            text: `stale receipt ${effect.receiptId}: page hash no longer matches the screen`,
            tone: "error",
          });
          reload();
          return false;
        }
        try {
          const revert = await undoReceipt(io, effect.receiptId);
          state = withNotice(state, {
            text: `undone ${effect.receiptId} → ${revert.receipt_id}`,
            tone: "ok",
          });
          state = { ...state, session: { undone: state.session.undone + 1 } };
        } catch (error) {
          state = withNotice(state, {
            text: errorText(error),
            tone: "error",
          });
        }
        reload();
        return false;
      }
      default: {
        const _never: never = effect;
        return _never;
      }
    }
  };

  const handleKey = async (key: Key): Promise<boolean> => {
    const { cols, rows } = terminal.size();
    const next = reduce(state, key, viewportFor(cols, rows));
    state = next.state;
    for (const effect of next.effects) {
      if (await runEffect(effect)) return true;
    }
    return false;
  };

  terminal.enter();
  try {
    draw();
  } catch (error) {
    terminal.leave();
    throw error;
  }

  return new Promise<AuditSummary>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      stopKeys();
      stopResize();
      stopClose();
      try {
        terminal.leave();
      } catch {
        // restore is idempotent; a second failure must not hide the outcome
      }
      if (error !== undefined) reject(error instanceof Error ? error : new Error(errorText(error)));
      else resolve({ ...state.session });
    };
    const safeDraw = (): void => {
      if (finished) return;
      try {
        draw();
      } catch (error) {
        finish(error);
      }
    };
    const stopResize = terminal.onResize(() => {
      if (!finished) safeDraw();
    });
    const stopClose = terminal.onClose(() => {
      finish();
    });
    let keyQueue: Promise<void> = Promise.resolve();
    const stopKeys = terminal.onKeys((keys) => {
      if (finished) return;
      keyQueue = keyQueue
        .then(async () => {
          if (finished) return;
          for (const key of keys) {
            if (await handleKey(key)) {
              finish();
              return;
            }
          }
          if (!finished) safeDraw();
        })
        .catch((error: unknown) => {
          finish(error);
        });
    });
  });
}
