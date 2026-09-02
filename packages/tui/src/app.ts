import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listAuditReceipts, listCanonReceipts, undoReceipt } from "@kizuki/core";
import type { AuditReceipt, CanonIo } from "@kizuki/core";
import { parseFrontmatter } from "@kizuki/core";
import { colorsEnabled, paint, sanitize, truncate } from "./ansi";
import type { Key } from "./keys";
import { applyItems, initialState, reduce, withNotice } from "./model";
import type { AuditItem, AuditState, Effect } from "./model";
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

const QUEUE_LIMIT = 5000;

function readBody(vaultPath: string, relPath: string | null): string | null {
  if (relPath === null) return null;
  const path = join(vaultPath, relPath);
  if (!existsSync(path)) return null;
  try {
    return parseFrontmatter(readFileSync(path, "utf8")).body;
  } catch {
    return readFileSync(path, "utf8");
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

function evidenceQuotes(receipt: AuditReceipt): string[] {
  return receipt.provenance.slice(0, 8).map((eventId) => sanitize(`event ${eventId}`));
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/** This receipt's after bytes, not whatever the page later became. */
function afterBody(
  vaultPath: string,
  receipt: AuditReceipt,
  db?: Database,
): string | null {
  const path = join(vaultPath, receipt.page_path);
  if (fileHash(path) === receipt.after_hash) {
    return readBody(vaultPath, receipt.page_path);
  }
  if (db === undefined) return null;
  const next = listCanonReceipts(db, {
    page_path: receipt.page_path,
    newest_first: false,
    limit: 10_000,
  }).find(
    (row) =>
      row.at > receipt.at || (row.at === receipt.at && row.receipt_id > receipt.receipt_id),
  );
  if (next === undefined || next.archive_path === null) return null;
  return readBody(vaultPath, next.archive_path);
}

export function toAuditItem(
  vaultPath: string,
  receipt: AuditReceipt,
  db?: Database,
): AuditItem {
  const currentBody = afterBody(vaultPath, receipt, db);
  const priorBody = readBody(vaultPath, receipt.archive_path);
  return {
    receipt,
    title: titleOf(receipt, currentBody ?? priorBody),
    priorBody,
    currentBody,
    evidence: evidenceQuotes(receipt),
  };
}

export function loadItems(db: Database, vaultPath: string): AuditItem[] {
  return listAuditReceipts(db, { limit: QUEUE_LIMIT }).map((receipt) =>
    toAuditItem(vaultPath, receipt, db),
  );
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

  let state: AuditState = initialState({
    vaultName,
    today: now().toISOString().slice(0, 10),
    items: loadItems(opts.db, opts.vaultPath),
  });

  const draw = (): void => {
    const { cols, rows } = terminal.size();
    terminal.draw(render(state, { cols, rows, paint: p }));
  };

  const reload = (): void => {
    state = applyItems(state, loadItems(opts.db, opts.vaultPath));
  };

  const runEffect = async (effect: Effect): Promise<boolean> => {
    switch (effect.type) {
      case "quit":
        return true;
      case "filter":
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
  draw();
  return new Promise<AuditSummary>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stopKeys();
      stopResize();
      terminal.leave();
      resolve({ ...state.session });
    };
    const stopResize = terminal.onResize(() => {
      if (!finished) draw();
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
          if (!finished) draw();
        })
        .catch((error: unknown) => {
          if (finished) return;
          state = withNotice(state, { text: errorText(error), tone: "error" });
          draw();
        });
    });
  });
}

export { pickEditor, editInEditor } from "./editor";
