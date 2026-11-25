import type { Database } from "bun:sqlite";
import {
  type ControlPathReport,
  type DoctrineFileReport,
  inspectDoctrineFiles,
  inspectVaultControl,
} from "./init";
import { listCanonPagesReport, type CanonPageReport } from "./pages";
import { parsePageSources, validatePage } from "./schema";

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

const EVENT_LOOKUP_BATCH = 500;

/** Without a ledger, this reports filesystem and schema health only. */
export function doctorVault(
  path: string,
  db?: Database,
  prewalked?: CanonPageReport,
): DoctorVaultResult {
  const report = prewalked ?? listCanonPagesReport(path, undefined, undefined, {
    include_body: false,
    track_capacity: false,
  });
  const inspect = (): DoctorPageResult[] => {
    if (db === undefined) {
      return report.pages.map((page) => ({
        page: page.relPath,
        errors: validatePage(page.data),
      }));
    }
    const parsedSources = report.pages.map((page) => parsePageSources(page.data));
    const neededIds = new Set<string>();
    let needsLedgerProbe = false;
    for (let i = 0; i < report.pages.length; i += 1) {
      const page = report.pages[i]!;
      const sources = parsedSources[i]!;
      if (sources.ok && page.data["status"] !== "archived") {
        needsLedgerProbe = true;
        for (const id of sources.value) neededIds.add(id);
      }
    }
    let existingEvents: Set<string> | null = new Set<string>();
    if (needsLedgerProbe) {
      try {
        if (neededIds.size === 0) {
          using probe = db.prepare<{ event_id: string }, [string]>(
            "SELECT event_id FROM events WHERE event_id=?",
          );
          probe.get("");
        } else {
          const ids = [...neededIds];
          for (let offset = 0; offset < ids.length; offset += EVENT_LOOKUP_BATCH) {
            const batch = ids.slice(offset, offset + EVENT_LOOKUP_BATCH);
            const placeholders = batch.map(() => "?").join(",");
            const rows = db
              .query<{ event_id: string }, string[]>(
                `SELECT event_id FROM events WHERE event_id IN (${placeholders})`,
              )
              .all(...batch);
            for (const row of rows) existingEvents.add(row.event_id);
          }
        }
      } catch {
        existingEvents = null;
      }
    }
    return report.pages.map((page, i) => {
      const errors = validatePage(page.data);
      const sources = parsedSources[i]!;
      if (!sources.ok) {
        errors.push(...sources.errors);
      } else if (page.data["status"] !== "archived") {
        if (existingEvents === null) {
          errors.push("sources: ledger provenance could not be checked");
        } else if (sources.value.some((id) => !existingEvents.has(id))) {
          errors.push("sources: one or more event IDs do not resolve in the ledger");
        }
      }
      return { page: page.relPath, errors };
    });
  };
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
