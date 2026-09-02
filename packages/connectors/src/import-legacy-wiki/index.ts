import {
  HealthReport,
  PAGE_CANDIDATE_KEY,
  isPlainObject,
  targetProblem,
} from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "../errors";
import { defaultMappingPath, loadMapping } from "../legacy/mapping-file";
import { resolveReportPath, writeReport } from "../legacy/report-file";
import { compareStrings, pathHealth, requirePathConfig } from "../util";
import {
  LEGACY_WIKI_FIXTURE,
  LEGACY_WIKI_FIXTURE_OBSERVED_AT,
  fixtureMappingHash,
  fixtureScan,
} from "./fixture";
import { LEGACY_WIKI_CONNECTOR_ID, parseLegacyWikiMapping } from "./mapping";
import type { LegacyWikiConfig, LegacyWikiMapping } from "./mapping";
import { planLegacyWiki } from "./plan";
import { renderLegacyWikiReport } from "./report";
import type { LegacyWikiReport } from "./report";
import { scanLegacyWiki } from "./scan";
import type { ScanResult } from "./scan";

/**
 * An importer for a previous markdown estate, not a live connector: it reads
 * an export the owner already has on disk, and every page it produces is
 * evidence. It never writes canon and never leaves the machine.
 */

export const LEGACY_WIKI_CURSOR_SCHEMA =
  "kizuki.legacy-wiki-cursor/v1" as const;

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: LEGACY_WIKI_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["page"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none"],
};

interface SnapshotEntry {
  /** So an edited page is re-emitted and a copied wiki with fresh mtimes is not. */
  hash: string;
  /** So a page added later cannot take a target this page is already staged at. */
  target: string;
}

interface LegacyWikiCursor {
  schema: typeof LEGACY_WIKI_CURSOR_SCHEMA;
  mapping_hash: string;
  /** Only pages this import actually emitted: a page the mapping excludes has
   * no ledger record to retract later. */
  files: Record<string, SnapshotEntry>;
}

function contentHash(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function targetOf(event: CaptureEventInput): string | null {
  const candidate = event.metadata[PAGE_CANDIDATE_KEY];
  if (!isPlainObject(candidate)) return null;
  const target = candidate["target"];
  return typeof target === "string" ? target : null;
}

function encodeCursor(
  scan: ScanResult,
  events: CaptureEventInput[],
  mappingHash: string,
): Cursor {
  const hashes = new Map(
    scan.files.map((file) => [file.relpath, contentHash(file.content)]),
  );
  const files: Record<string, SnapshotEntry> = {};
  for (const event of events) {
    const hash = hashes.get(event.source_record_id);
    const target = targetOf(event);
    if (hash === undefined || target === null) continue;
    files[event.source_record_id] = { hash, target };
  }
  const cursor: LegacyWikiCursor = {
    schema: LEGACY_WIKI_CURSOR_SCHEMA,
    mapping_hash: mappingHash,
    files,
  };
  return JSON.stringify(cursor);
}

/**
 * The snapshot entries this scan proves are gone. A page the scan could not
 * read — unreadable, not UTF-8, oversized, ignored, past the depth limit — is
 * missing information, not a deletion, and a truncated walk never saw the rest
 * of the wiki at all. A directory the walk never entered is the same gap one
 * level up: every page beneath it is unseen, not removed. Absence has to be
 * conclusive before the ledger is told a source record was removed.
 */
export function goneFromSnapshot(
  previous: Record<string, SnapshotEntry>,
  scan: ScanResult,
): string[] {
  if (scan.truncated) return [];
  const seen = new Set<string>();
  for (const file of scan.files) seen.add(file.relpath);
  const unentered: string[] = [];
  for (const entry of scan.skipped) {
    seen.add(entry.relpath);
    if (entry.kind === "directory") unentered.push(`${entry.relpath}/`);
  }
  return Object.keys(previous)
    .filter(
      (relpath) =>
        !seen.has(relpath) &&
        !unentered.some((prefix) => relpath.startsWith(prefix)),
    )
    .sort(compareStrings);
}

function isSnapshotEntry(raw: unknown): raw is SnapshotEntry {
  return (
    isPlainObject(raw) &&
    typeof raw["hash"] === "string" &&
    typeof raw["target"] === "string" &&
    targetProblem(raw["target"]) === null
  );
}

function decodeCursor(cursor: Cursor): LegacyWikiCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_WIKI_CONNECTOR_ID}: malformed cursor`,
      { cause: error },
    );
  }
  if (
    !isPlainObject(parsed) ||
    parsed["schema"] !== LEGACY_WIKI_CURSOR_SCHEMA ||
    typeof parsed["mapping_hash"] !== "string" ||
    !isPlainObject(parsed["files"]) ||
    !Object.values(parsed["files"]).every(isSnapshotEntry)
  ) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_WIKI_CONNECTOR_ID}: malformed cursor`,
    );
  }
  return {
    schema: LEGACY_WIKI_CURSOR_SCHEMA,
    mapping_hash: parsed["mapping_hash"],
    files: parsed["files"] as Record<string, SnapshotEntry>,
  };
}

function pinnedTargets(
  files: Record<string, SnapshotEntry>,
): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const [relpath, entry] of Object.entries(files)) {
    pinned[relpath] = entry.target;
  }
  return pinned;
}

function tombstone(relpath: string, observedAt: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: LEGACY_WIKI_CONNECTOR_ID,
    source_record_id: relpath,
    kind: "page",
    occurred_at: observedAt,
    observed_at: observedAt,
    text: "",
    subjects: [],
    deleted: true,
    attachments: [],
    metadata: { relpath },
  };
}

export class LegacyWikiConnector implements Connector {
  readonly path: string;
  readonly mapping: LegacyWikiMapping;
  readonly mappingHash: string;
  readonly reportPath: string | null;
  #report: LegacyWikiReport | null = null;
  #degraded = 0;

  constructor(config: LegacyWikiConfig) {
    this.path = requirePathConfig(config, LEGACY_WIKI_CONNECTOR_ID);
    const loaded = loadMapping(
      config.mapping,
      defaultMappingPath(this.path, "directory"),
      LEGACY_WIKI_CONNECTOR_ID,
    );
    this.mapping = parseLegacyWikiMapping(loaded.raw);
    this.mappingHash = loaded.hash;
    this.reportPath = resolveReportPath(
      config.report,
      this.path,
      LEGACY_WIKI_CONNECTOR_ID,
    );
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async health(): Promise<HealthReport> {
    const base = await pathHealth(this.path, "directory");
    if (base.state !== "ok" || this.#degraded === 0) return base;
    return new HealthReport({
      state: "degraded",
      checked_at: base.checked_at,
      // Counts only: a file name from an unreadable page is still source text.
      detail: `${this.#degraded} file(s) skipped; see the report`,
    });
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    if (cursor !== null) decodeCursor(cursor);
    // A backfill is always a full walk; the snapshot is still returned so a
    // later sync knows what the wiki held.
    const { scan, events } = await this.#run([], {});
    return { events, cursor: encodeCursor(scan, events, this.mappingHash) };
  }

  async sync(cursor: Cursor | null): Promise<SyncBatch> {
    if (cursor === null) return this.backfill(null);
    const previous = decodeCursor(cursor);
    const changed = previous.mapping_hash !== this.mappingHash;
    const notes = changed ? ["mapping_changed"] : [];
    // A mapping change replans the whole wiki, so the old targets no longer
    // describe it; every page is re-emitted anyway, consistently.
    const { scan, events } = await this.#run(
      notes,
      changed ? {} : pinnedTargets(previous.files),
    );

    const hashes = new Map(
      scan.files.map((file) => [file.relpath, contentHash(file.content)]),
    );
    // A copy: the snapshot below is built from what the walk found, and the
    // tombstones about to be pushed are not part of that.
    const kept = changed
      ? [...events]
      : events.filter(
          (event) =>
            hashes.get(event.source_record_id) !==
            previous.files[event.source_record_id]?.hash,
        );

    const observedAt = new Date().toISOString();
    for (const relpath of goneFromSnapshot(previous.files, scan)) {
      kept.push(tombstone(relpath, observedAt));
    }
    kept.sort((a, b) => compareStrings(a.source_record_id, b.source_record_id));
    return {
      events: kept,
      cursor: encodeCursor(scan, events, this.mappingHash),
    };
  }

  async revoke(): Promise<void> {}

  /** The wiki files are the owner's own; purge is a ledger-side operation. */
  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return planLegacyWiki(fixtureScan(), LEGACY_WIKI_FIXTURE.mapping, {
      observedAt: LEGACY_WIKI_FIXTURE_OBSERVED_AT,
      mappingHash: fixtureMappingHash(),
    }).events;
  }

  /** The report from the most recent run on this instance. */
  lastReport(): LegacyWikiReport | null {
    return this.#report;
  }

  async #run(
    notes: string[],
    pinned: Record<string, string>,
  ): Promise<{ scan: ScanResult; events: CaptureEventInput[] }> {
    const scan = await scanLegacyWiki(this.path, this.mapping.ignore);
    const { events, report } = planLegacyWiki(scan, this.mapping, {
      observedAt: new Date().toISOString(),
      mappingHash: this.mappingHash,
      pinned,
    });
    report.notes.push(...notes);
    this.#report = report;
    this.#degraded = scan.skipped.filter(
      (entry) => entry.reason === "unreadable" || entry.reason === "not_utf8",
    ).length;
    if (this.reportPath !== null) {
      writeReport(this.reportPath, report, () =>
        renderLegacyWikiReport(report),
      );
    }
    return { scan, events };
  }
}

export function createLegacyWikiConnector(
  config: LegacyWikiConfig,
): LegacyWikiConnector {
  return new LegacyWikiConnector(config);
}

export { LEGACY_WIKI_CONNECTOR_ID, parseLegacyWikiMapping } from "./mapping";
export type { LegacyWikiConfig, LegacyWikiMapping } from "./mapping";
export { LEGACY_WIKI_FIXTURE } from "./fixture";
export { parseLegacyFrontmatter } from "./frontmatter";
export type { LegacyFrontmatter } from "./frontmatter";
export { planLegacyWiki } from "./plan";
export { LEGACY_WIKI_REPORT_SCHEMA, renderLegacyWikiReport } from "./report";
export type {
  LegacyWikiFieldReport,
  LegacyWikiPageReport,
  LegacyWikiReport,
} from "./report";
export { scanLegacyWiki } from "./scan";
export type { LegacyWikiFile, ScanResult } from "./scan";
