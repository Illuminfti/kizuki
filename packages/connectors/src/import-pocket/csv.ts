import { KizukiError } from "../errors";
import { MAX_RECORDS, MAX_RECORD_BYTES } from "../util";

export interface CsvOptions {
  maxFieldBytes?: number;
  maxRows?: number;
}

export interface CsvRow {
  cells: string[];
  /** 1-based line of the file the row started on. */
  line: number;
}

/**
 * RFC 4180 with bounds. An export CSV is attacker-controlled the moment the
 * owner downloads it, so a field and a row count are both capped, and every
 * refusal names a position rather than the value that failed.
 *
 * The position is the line the row began on, counted in the file. A blank line
 * between rows is skipped but still consumed, so counting kept rows instead
 * would send the owner to a line that is not the one that failed.
 */
export function parseCsvRows(
  text: string,
  where: string,
  opts: CsvOptions = {},
): CsvRow[] {
  const maxFieldBytes = opts.maxFieldBytes ?? MAX_RECORD_BYTES;
  const maxRows = opts.maxRows ?? MAX_RECORDS;
  const source = text.replace(/\r\n?/g, "\n");

  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let fieldStarted = false;
  let rowStarted = false;
  let line = 1;
  let rowLine = 1;

  const fail = (detail: string): never => {
    throw new KizukiError("parse_error", `${where} row ${rowLine}: ${detail}`);
  };

  const startRow = (): void => {
    if (!rowStarted) rowLine = line;
    rowStarted = true;
  };

  // A field is bounded as it grows, not once it is whole: a hostile export
  // must not be able to make the reader hold what it is going to refuse. One
  // UTF-8 byte per code unit at least, so this never refuses early.
  const append = (character: string): void => {
    field += character;
    if (field.length > maxFieldBytes) {
      fail(`field exceeds ${maxFieldBytes} bytes`);
    }
  };

  const endField = (): void => {
    if (Buffer.byteLength(field, "utf8") > maxFieldBytes) {
      fail(`field exceeds ${maxFieldBytes} bytes`);
    }
    cells.push(field);
    field = "";
    fieldStarted = false;
    quoteClosed = false;
  };

  const endRow = (): void => {
    endField();
    if (rowStarted) {
      if (rows.length >= maxRows) {
        throw new KizukiError(
          "parse_error",
          `${where}: more than ${maxRows} rows`,
        );
      }
      rows.push({ cells, line: rowLine });
    }
    cells = [];
    rowStarted = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          append('"');
          index += 1;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        continue;
      }
      if (character === "\n") line += 1;
      append(character);
      continue;
    }
    // Only a delimiter, a newline or the end of the input may follow a
    // closing quote. Appending whatever came after it would rewrite the
    // owner's evidence in silence, so it is a named refusal instead.
    if (quoteClosed && character !== "," && character !== "\n") {
      fail("unexpected text after a closing quote");
    }
    if (character === '"') {
      if (fieldStarted) fail("unexpected quote inside an unquoted field");
      inQuotes = true;
      fieldStarted = true;
      startRow();
      continue;
    }
    if (character === ",") {
      endField();
      startRow();
      continue;
    }
    if (character === "\n") {
      endRow();
      line += 1;
      continue;
    }
    append(character);
    fieldStarted = true;
    startRow();
  }

  if (inQuotes) fail("unterminated quote");
  if (rowStarted) endRow();
  return rows;
}

export function parseCsv(
  text: string,
  where: string,
  opts: CsvOptions = {},
): string[][] {
  return parseCsvRows(text, where, opts).map((row) => row.cells);
}
