import { KizukiError, isPlainObject } from "@kizuki/core";
import type { Cursor } from "@kizuki/core";
import { formatSet, parseSet } from "./uidset";

export const IMAP_CURSOR_SCHEMA = "kizuki.imap-cursor/v1" as const;

export interface ImapFolderCursor {
  uidvalidity: number;
  /** Next UID window start; 1 at the beginning of a walk. */
  scan_from: number;
  /** UIDNEXT observed at the last EXAMINE. */
  uidnext: number;
  /** Sequence set of UIDs already emitted; `""` means none. */
  known: string;
  done: boolean;
}

export interface ImapCursor {
  schema: typeof IMAP_CURSOR_SCHEMA;
  folders: Record<string, ImapFolderCursor>;
}

const FOLDER_FIELDS = [
  "uidvalidity",
  "scan_from",
  "uidnext",
  "known",
  "done",
] as const;

function invalid(what: string): never {
  throw new KizukiError("parse_error", `kizuki.imap: invalid cursor ${what}`);
}

function positiveInteger(raw: unknown, what: string): number {
  if (!Number.isInteger(raw) || (raw as number) < 0) invalid(what);
  return raw as number;
}

export function emptyCursor(): ImapCursor {
  return { schema: IMAP_CURSOR_SCHEMA, folders: {} };
}

export function encodeCursor(cursor: ImapCursor): Cursor {
  return JSON.stringify(cursor);
}

export function decodeCursor(raw: Cursor): ImapCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new KizukiError("parse_error", "kizuki.imap: malformed cursor", {
      cause: error,
    });
  }
  if (!isPlainObject(parsed) || parsed["schema"] !== IMAP_CURSOR_SCHEMA) {
    invalid("schema");
  }
  const folders = parsed["folders"];
  if (!isPlainObject(folders)) invalid("folders");
  const decoded: Record<string, ImapFolderCursor> = {};
  for (const [folder, value] of Object.entries(folders)) {
    if (!isPlainObject(value)) invalid("folder entry");
    for (const key of Object.keys(value)) {
      if (!(FOLDER_FIELDS as readonly string[]).includes(key)) {
        invalid("folder field");
      }
    }
    if (typeof value["done"] !== "boolean") invalid("done");
    if (typeof value["known"] !== "string") invalid("known");
    decoded[folder] = {
      uidvalidity: positiveInteger(value["uidvalidity"], "uidvalidity"),
      scan_from: positiveInteger(value["scan_from"], "scan_from"),
      uidnext: positiveInteger(value["uidnext"], "uidnext"),
      known: formatSet(parseSet(value["known"])),
      done: value["done"],
    };
  }
  return { schema: IMAP_CURSOR_SCHEMA, folders: decoded };
}
