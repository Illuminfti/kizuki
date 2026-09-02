import { KizukiError } from "../errors";
import { MAX_RECORDS, MAX_RECORD_BYTES } from "../util";

export interface CsvOptions {
  maxFieldBytes?: number;
  maxRows?: number;
}

/**
 * RFC 4180 with bounds. An export CSV is attacker-controlled the moment the
 * owner downloads it, so a field and a row count are both capped, and every
 * refusal names a position rather than the value that failed.
 */
export function parseCsv(
  text: string,
  where: string,
  opts: CsvOptions = {},
): string[][] {
  const maxFieldBytes = opts.maxFieldBytes ?? MAX_RECORD_BYTES;
  const maxRows = opts.maxRows ?? MAX_RECORDS;
  const source = text.replace(/\r\n?/g, "\n");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let fieldStarted = false;
  let rowStarted = false;

  const fail = (detail: string): never => {
    throw new KizukiError(
      "parse_error",
      `${where} row ${rows.length + 1}: ${detail}`,
    );
  };

  const endField = (): void => {
    if (Buffer.byteLength(field, "utf8") > maxFieldBytes) {
      fail(`field exceeds ${maxFieldBytes} bytes`);
    }
    row.push(field);
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
      rows.push(row);
    }
    row = [];
    rowStarted = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        continue;
      }
      field += character;
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
      rowStarted = true;
      continue;
    }
    if (character === ",") {
      endField();
      rowStarted = true;
      continue;
    }
    if (character === "\n") {
      endRow();
      continue;
    }
    field += character;
    fieldStarted = true;
    rowStarted = true;
  }

  if (inQuotes) fail("unterminated quote");
  if (rowStarted) endRow();
  return rows;
}
