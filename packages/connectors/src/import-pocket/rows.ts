import { KizukiError } from "../errors";
import { unixSecondsToIso } from "../util";
import { parseCsv, parseCsvRows } from "./csv";
import type { CsvOptions } from "./csv";

export interface PocketRow {
  title: string;
  url: string;
  /** Unix seconds, exactly as the export wrote them. */
  time_added: string;
  tags: string[];
  /** What the export said, verbatim: the cell is evidence, not a value. */
  status: string;
}

// The final export format. `time_added` is unix seconds and `tags` are
// pipe-separated; column order is not guaranteed, so the parser is
// header-driven and ignores columns it does not know.
const REQUIRED_COLUMNS = ["url", "time_added"];
const MAX_URL_LENGTH = 4096;

function notPocketExport(where: string, cause?: unknown): KizukiError {
  return new KizukiError(
    "parse_error",
    `${where}: not a Pocket CSV export`,
    cause === undefined ? undefined : { cause },
  );
}

/** The columns a header names, or a refusal naming the file but never a cell. */
function pocketColumns(
  header: readonly string[],
  where: string,
): string[] {
  const columns = header.map((name) => name.trim().toLowerCase());
  if (!REQUIRED_COLUMNS.every((name) => columns.includes(name))) {
    throw notPocketExport(where);
  }
  return columns;
}

/** The same check from one line, for a health probe that reads no further. */
export function pocketHeaderLine(line: string, where: string): string[] {
  let header: string[];
  try {
    header = parseCsv(line, where)[0] ?? [];
  } catch (error) {
    throw notPocketExport(where, error);
  }
  return pocketColumns(header, where);
}

export function parsePocketCsv(
  text: string,
  where: string,
  opts: CsvOptions = {},
): PocketRow[] {
  // The header comes out of the reader, not out of a separate split: the
  // reader skips a blank line before it, and a header taken from the raw
  // first line would call such an export "not a Pocket CSV export".
  const rows = parseCsvRows(text, where, opts);
  const columns = pocketColumns(rows[0]?.cells ?? [], where);
  const cellOf = (cells: string[], name: string): string => {
    const at = columns.indexOf(name);
    return at === -1 ? "" : (cells[at] ?? "");
  };

  return rows.slice(1).map(({ cells, line }) => {
    // The line the row began on, not its position among the rows kept: a
    // blank line between records would otherwise shift every number after it.
    const at = `${where} row ${line}`;
    if (cells.length !== columns.length) {
      throw new KizukiError(
        "parse_error",
        `${at}: expected ${columns.length} columns, found ${cells.length}`,
      );
    }
    const url = cellOf(cells, "url").trim();
    if (url.length === 0) {
      throw new KizukiError("parse_error", `${at}: url is required`);
    }
    if (url.length > MAX_URL_LENGTH) {
      throw new KizukiError(
        "parse_error",
        `${at}: url exceeds ${MAX_URL_LENGTH} characters`,
      );
    }
    const time_added = cellOf(cells, "time_added").trim();
    // Checked here, where the file name and the row number exist to name in
    // the refusal. The instant itself is derived again where the event is
    // built, so a row stays the five fields the export has.
    unixSecondsToIso(time_added, at);
    return {
      title: cellOf(cells, "title").trim(),
      url,
      time_added,
      tags: cellOf(cells, "tags")
        .split("|")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      status: cellOf(cells, "status"),
    };
  });
}
