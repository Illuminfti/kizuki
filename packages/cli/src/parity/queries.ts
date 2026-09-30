import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { UsageError } from "../args";

export const MAX_QUERIES = 200;
export const MAX_QUERY_CHARS = 512;
const MAX_QUERY_FILE_BYTES = 256 * 1024;
// The context packet's own text contract, so a query that parses here is accepted there.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function readBounded(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new UsageError("invalid arguments: --queries: file cannot be read");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new UsageError("invalid arguments: --queries: not a regular file");
    if (stat.size > MAX_QUERY_FILE_BYTES) {
      throw new UsageError(`invalid arguments: --queries: file exceeds ${MAX_QUERY_FILE_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** One query per line; blank lines and lines starting with `#` are skipped. Errors never echo a query. */
export function readQuerySet(path: string): string[] {
  const queries: string[] = [];
  for (const [index, line] of readBounded(path).split(/\r?\n/).entries()) {
    const query = line.trim();
    if (query.length === 0 || query.startsWith("#")) continue;
    if (CONTROL_CHARACTERS.test(query)) {
      throw new UsageError(`invalid arguments: --queries line ${index + 1}: must not contain control characters`);
    }
    if (Array.from(query).length > MAX_QUERY_CHARS) {
      throw new UsageError(`invalid arguments: --queries line ${index + 1}: must be at most ${MAX_QUERY_CHARS} characters`);
    }
    queries.push(query);
    if (queries.length > MAX_QUERIES) {
      throw new UsageError(`invalid arguments: --queries: at most ${MAX_QUERIES} queries`);
    }
  }
  if (queries.length === 0) throw new UsageError("invalid arguments: --queries: no queries in file");
  return queries;
}
