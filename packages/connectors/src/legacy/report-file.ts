import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { ulid } from "@kizuki/core";
import { KizukiError } from "../errors";
import { errorMessage } from "../util";

/**
 * The lossy-mapping report is a first-class artifact of a migration, so it is
 * written the way canon is: to a private temporary file, then renamed into
 * place, so a reader never sees a half-written decision record.
 */

/** Deep enough for any real tree; a bound, because the walk is on hostile input. */
const MAX_ANCESTORS = 64;

/** Where a path really is, once every symlink in its parents is resolved. */
function canonical(path: string): string {
  const parent = dirname(path);
  if (!existsSync(parent)) return path;
  try {
    return join(realpathSync(parent), basename(path));
  } catch {
    return path;
  }
}

/**
 * A vault is a directory holding `.kizuki`. A report written inside one would
 * put a Markdown file in the canon tree that no receipt covers — a second
 * door into the page namespace, opened by configuration rather than by code.
 */
function vaultAbove(path: string): string | null {
  let directory = dirname(path);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (existsSync(join(directory, ".kizuki"))) return directory;
    const up = dirname(directory);
    if (up === directory || up === parse(directory).root) return null;
    directory = up;
  }
  return null;
}

/** A report inside the source would be imported as a page on the next run. */
export function resolveReportPath(
  report: string | undefined,
  sourcePath: string,
  connectorId: string,
): string | null {
  if (report === undefined) return null;
  // Canonical, so a symlinked parent cannot walk the report into a directory
  // the checks below would have refused by name.
  const absolute = canonical(resolve(report));
  const source = canonical(resolve(sourcePath));
  if (absolute === source || absolute.startsWith(`${source}${sep}`)) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: report path must be outside the source: ${absolute}`,
    );
  }
  if (absolute.split(sep).includes(".kizuki")) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: report path must be outside a .kizuki directory: ${absolute}`,
    );
  }
  const vault = vaultAbove(absolute);
  if (vault !== null) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: report path must be outside the vault at ${vault}: ${absolute}`,
    );
  }
  return absolute;
}

export function writeReport(
  path: string,
  document: unknown,
  markdown: () => string,
): void {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    throw new KizukiError(
      "misconfigured",
      `report: parent directory does not exist: ${directory}`,
    );
  }
  const contents = path.endsWith(".json")
    ? `${JSON.stringify(document, null, 2)}\n`
    : markdown();
  const temporary = `${path}.${ulid()}.tmp`;
  try {
    // `wx` fails on anything already at that path, a symlink included, so the
    // write cannot be redirected through one left in the report directory.
    writeFileSync(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // An existing file keeps its old mode through writeFileSync; this path is
    // fresh, but the report can name every field an estate had, so pin it.
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new KizukiError(
      "misconfigured",
      `report: cannot write ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
