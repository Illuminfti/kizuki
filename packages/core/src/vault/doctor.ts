import type { Database } from "bun:sqlite";
import {
  type ControlPathReport,
  type DoctrineFileReport,
  inspectDoctrineFiles,
  inspectVaultControl,
} from "./init";
import { scanCanonPages, type CanonScanReport } from "./pages";
import { pageProvenanceErrors } from "./provenance";

export interface DoctorPageResult {
  page: string;
  errors: string[];
}

export interface DoctorVaultResult {
  pages: DoctorPageResult[];
  counts: {
    total: number;
    valid: number;
    invalid: number;
  };
  doctrine: DoctrineFileReport[];
  control: ControlPathReport[];
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Without a ledger, this reports filesystem and schema health only. */
export function doctorVault(path: string, db?: Database): DoctorVaultResult {
  const { scan, vault } = inspectDoctorCanon(path, db);
  const validPaths = new Set(scan.pages.map(page => page.relPath));
  const failures = new Map(vault.pages.map(page => [page.page, page]));
  return { ...vault, pages: [
    ...scan.pages.map(page => failures.get(page.relPath) ?? { page: page.relPath, errors: [] }),
    ...vault.pages.filter(page => !validPaths.has(page.page)),
  ].sort((a, b) => comparePath(a.page, b.page)) };
}

/** Share one validated header snapshot; vault.pages contains diagnostics only. */
export function inspectDoctorCanon(path: string, db?: Database): { vault: DoctorVaultResult; scan: CanonScanReport } {
  const results = new Map<string, DoctorPageResult>();
  const inspect = () => scanCanonPages(path, page => {
    const errors = db === undefined ? [] : pageProvenanceErrors(db, page.data);
    if (errors.length > 0) results.set(page.relPath, { page: page.relPath, errors });
  });
  const report = db === undefined ? inspect() : db.transaction(inspect).deferred();
  const pages: DoctorPageResult[] = [
    ...report.pages.flatMap(page => { const result = results.get(page.relPath); return result === undefined ? [] : [result]; }),
    ...report.skipped.map((skipped) => ({
      page: skipped.relPath,
      errors: [`frontmatter: ${skipped.reason}`],
    })),
  ].sort((a, b) => comparePath(a.page, b.page));
  const total = report.pages.length + report.skipped.length;
  const valid = total - pages.length;

  return { scan: report, vault: {
    pages,
    counts: {
      total,
      valid,
      invalid: pages.length,
    },
    doctrine: inspectDoctrineFiles(path),
    control: inspectVaultControl(path),
  } };
}
