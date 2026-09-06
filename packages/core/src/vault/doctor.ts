import type { Database } from "bun:sqlite";
import {
  type ControlPathReport,
  type DoctrineFileReport,
  inspectDoctrineFiles,
  inspectVaultControl,
} from "./init";
import { listCanonPagesReport } from "./pages";
import { pageProvenanceErrors } from "./provenance";
import { validatePage } from "./schema";

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
  const report = listCanonPagesReport(path);
  const inspect = (): DoctorPageResult[] => report.pages.map((page) => ({
    page: page.relPath,
    errors: [
      ...validatePage(page.data),
      ...(db === undefined ? [] : pageProvenanceErrors(db, page.data)),
    ],
  }));
  const pages: DoctorPageResult[] = [
    ...(db === undefined ? inspect() : db.transaction(inspect).deferred()),
    ...report.skipped.map((skipped) => ({
      page: skipped.relPath,
      errors: [`frontmatter: ${skipped.reason}`],
    })),
  ].sort((a, b) => comparePath(a.page, b.page));
  const valid = pages.filter(({ errors }) => errors.length === 0).length;

  return {
    pages,
    counts: {
      total: pages.length,
      valid,
      invalid: pages.length - valid,
    },
    doctrine: inspectDoctrineFiles(path),
    control: inspectVaultControl(path),
  };
}
