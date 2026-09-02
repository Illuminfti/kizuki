import {
  chmodSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ulid } from "@kizuki/core";
import { KizukiError } from "../errors";
import { errorMessage } from "../util";

/**
 * The lossy-mapping report is a first-class artifact of a migration, so it is
 * written the way canon is: to a private temporary file, then renamed into
 * place, so a reader never sees a half-written decision record.
 */

/** A report inside the source would be imported as a page on the next run. */
export function resolveReportPath(
  report: string | undefined,
  sourcePath: string,
  connectorId: string,
): string | null {
  if (report === undefined) return null;
  const absolute = resolve(report);
  const source = resolve(sourcePath);
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
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
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
