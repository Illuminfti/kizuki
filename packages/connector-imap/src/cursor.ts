import { KizukiError, isPlainObject, sha256Hex } from "@kizuki/core";
import type { Cursor, CursorStoreDelta } from "@kizuki/core";
import { formatSet, parseSet } from "./uidset";

export const IMAP_CURSOR_SCHEMA = "kizuki.imap-cursor/v2" as const;
/**
 * The first cursor carried every folder, including its whole seen-UID set,
 * which outgrows the host's cursor bound on a fragmented mailbox. It is still
 * read, once, so a checkpoint minted before the host store moves its folders
 * there instead of restarting.
 */
const LEGACY_CURSOR_SCHEMA = "kizuki.imap-cursor/v1" as const;
const FOLDER_KEY = "folder:";

export interface ImapFolderCursor {
  uidvalidity: number;
  /** Next UID window start; 1 at the beginning of a walk. */
  scan_from: number;
  /** UIDNEXT observed at the last EXAMINE. */
  uidnext: number;
  /** Sequence set of UIDs already emitted; `""` means none. */
  known: string;
  /**
   * Sequence set of UIDs the server listed but whose body it did not hand
   * over. They are retried on every later walk; without them a transient
   * FETCH failure would lose a message with nothing left to find it by.
   */
  pending: string;
  done: boolean;
}

/**
 * The state a walk works on. On the wire it is only a digest: each folder's
 * entry lives in the host's cursor store, keyed by mailbox name.
 */
export interface ImapCursor {
  schema: typeof IMAP_CURSOR_SCHEMA;
  folders: Record<string, ImapFolderCursor>;
}

const FOLDER_FIELDS = [
  "uidvalidity",
  "scan_from",
  "uidnext",
  "known",
  "pending",
  "done",
] as const;

function invalid(what: string): never {
  throw new KizukiError("parse_error", `kizuki.imap: invalid cursor ${what}`);
}

function positiveInteger(raw: unknown, what: string): number {
  if (
    !Number.isInteger(raw) ||
    (raw as number) < 1 ||
    (raw as number) > 4294967295
  ) invalid(what);
  return raw as number;
}

export function emptyCursor(): ImapCursor {
  // Mailbox names are literal keys, including names inherited by plain objects.
  return { schema: IMAP_CURSOR_SCHEMA, folders: Object.create(null) };
}

function decodeFolder(value: unknown): ImapFolderCursor {
  if (!isPlainObject(value)) invalid("folder entry");
  for (const key of Object.keys(value)) {
    if (!(FOLDER_FIELDS as readonly string[]).includes(key)) {
      invalid("folder field");
    }
  }
  if (typeof value["done"] !== "boolean") invalid("done");
  if (typeof value["known"] !== "string") invalid("known");
  if (typeof value["pending"] !== "string") invalid("pending");
  return {
    uidvalidity: positiveInteger(value["uidvalidity"], "uidvalidity"),
    scan_from: positiveInteger(value["scan_from"], "scan_from"),
    uidnext: positiveInteger(value["uidnext"], "uidnext"),
    known: formatSet(parseSet(value["known"])),
    pending: formatSet(parseSet(value["pending"])),
    done: value["done"],
  };
}

/** One folder as the host store holds it. */
export function encodeFolder(entry: ImapFolderCursor): string {
  return JSON.stringify({
    uidvalidity: entry.uidvalidity,
    scan_from: entry.scan_from,
    uidnext: entry.uidnext,
    known: entry.known,
    pending: entry.pending,
    done: entry.done,
  });
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new KizukiError("parse_error", `kizuki.imap: malformed ${what}`, {
      cause: error,
    });
  }
}

/**
 * The state a walk starts from. No cursor is an empty walk; a v2 cursor names
 * a map the host store holds; a v1 cursor carries its folders itself.
 */
export function loadCursor(
  raw: Cursor | null,
  store: ReadonlyMap<string, string>,
): ImapCursor {
  const cursor = emptyCursor();
  if (raw === null) return cursor;
  const parsed = parseJson(raw, "cursor");
  if (!isPlainObject(parsed)) invalid("schema");
  if (parsed["schema"] === LEGACY_CURSOR_SCHEMA) {
    const folders = parsed["folders"];
    if (!isPlainObject(folders)) invalid("folders");
    for (const [folder, value] of Object.entries(folders)) {
      cursor.folders[folder] = decodeFolder(value);
    }
    return cursor;
  }
  const keys = Object.keys(parsed);
  if (
    parsed["schema"] !== IMAP_CURSOR_SCHEMA ||
    keys.length !== 2 ||
    typeof parsed["digest"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed["digest"])
  ) {
    invalid("schema");
  }
  for (const [key, value] of store) {
    if (!key.startsWith(FOLDER_KEY)) invalid("store key");
    cursor.folders[key.slice(FOLDER_KEY.length)] = decodeFolder(parseJson(value, "folder entry"));
  }
  return cursor;
}

function storeEntries(cursor: ImapCursor): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [folder, entry] of Object.entries(cursor.folders)) {
    entries.set(`${FOLDER_KEY}${folder}`, encodeFolder(entry));
  }
  return entries;
}

/** The checkpoint token: it names the folder map, which the host store holds. */
export function wireCursor(cursor: ImapCursor): Cursor {
  const lines = [...storeEntries(cursor)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return JSON.stringify({
    schema: IMAP_CURSOR_SCHEMA,
    digest: sha256Hex(lines.join("\n")),
  });
}

/** Entries the host store must change to hold `cursor`; absent when it already does. */
export function cursorStoreDelta(
  held: ReadonlyMap<string, string>,
  cursor: ImapCursor,
): CursorStoreDelta | undefined {
  const wanted = storeEntries(cursor);
  const delta: Record<string, string | null> = {};
  for (const [key, value] of wanted) {
    if (held.get(key) !== value) delta[key] = value;
  }
  for (const key of held.keys()) {
    if (!wanted.has(key)) delta[key] = null;
  }
  return Object.keys(delta).length === 0 ? undefined : delta;
}
