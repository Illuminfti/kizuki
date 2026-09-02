import { listCanonPagesReport } from "./pages";
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
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function doctorVault(path: string): DoctorVaultResult {
  const report = listCanonPagesReport(path);
  const pages: DoctorPageResult[] = [
    ...report.pages.map((page) => ({
      page: page.relPath,
      errors: validatePage(page.data),
    })),
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
  };
}
