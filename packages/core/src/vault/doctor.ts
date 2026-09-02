import { compareCodePoints } from "../util/text";
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

export function doctorVault(path: string): DoctorVaultResult {
  // Tolerant on purpose: a note the OS refuses is exactly the kind of broken
  // vault this verb exists to describe, so it becomes a problem line instead
  // of an errno that replaces the whole report.
  const report = listCanonPagesReport(path, { tolerateUnreadable: true });
  const pages: DoctorPageResult[] = [
    ...report.pages.map((page) => ({
      page: page.relPath,
      errors: validatePage(page.data),
    })),
    ...report.skipped.map((skipped) => ({
      page: skipped.relPath,
      errors: [`frontmatter: ${skipped.reason}`],
    })),
  ].sort((a, b) => compareCodePoints(a.page, b.page));
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
