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
    // The pages are the owner's own prose, mapped by a file the owner wrote,
    // so this source is entitled to stage a typed page rather than a quoted
    // capture note. The host reads the grant here, never from an event.
    page_candidates: true,
  },
  required_secrets: [],
  // Every page leaves this connector labeled at or above the floor its own
  // source class carries; see `../legacy/sensitivity.ts`.
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
  /** Every page the ledger still holds a record for: the ones this run
   * emitted, plus the ones it could not read and therefore could not decide
   * anything about. A page dropped from here can never be withdrawn again. */
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
  carried: Record<string, SnapshotEntry>,
): Cursor {
  const hashes = new Map(
    scan.files.map((file) => [file.relpath, contentHash(file.content)]),
  );
  // The unseen pages first: a page this walk could not read keeps the entry
  // the last run left, so a later run that does see it gone can still say so.
  const files: Record<string, SnapshotEntry> = { ...carried };
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

export type Withdrawal = { relpath: string; reason: "absent" | "excluded" };

export interface SnapshotReconciliation {
  /** Snapshot pages the ledger must be told about, and what happened to them. */
  withdrawn: Withdrawal[];
  /** Snapshot pages this run decided nothing about; they stay in the cursor. */
  carried: string[];
}

/**
 * What this run proved about the pages the last one left behind.
 *
 * A page is withdrawn only when its absence from the import is conclusive: it
 * is gone from the disk, or it is still there and the mapping no longer
 * imports it — an excluded type, or a path the `ignore` list now matches.
 * Either way the proposal it filed has nothing behind it any more.
 *
 * A page the scan could not read — unreadable, not UTF-8, oversized, past the
 * depth limit, behind a directory the walk never entered — is missing
 * information, not a decision, and a truncated walk never saw the rest of the
 * wiki at all. Those are carried: dropping them would silently make the page
 * unwithdrawable, because a snapshot is the only record that it was ever
 * imported.
 */
export function reconcileSnapshot(
  previous: Record<string, SnapshotEntry>,
  scan: ScanResult,
  emitted: ReadonlySet<string>,
): SnapshotReconciliation {
  // On disk and read this run, or on disk and deliberately passed over.
  const present = new Set<string>();
  const unreadable = new Set<string>();
  const unentered: string[] = [];
  const excludedTrees: string[] = [];
  for (const file of scan.files) present.add(file.relpath);
  for (const entry of scan.skipped) {
    if (entry.reason === "ignored") {
      if (entry.kind === "directory") excludedTrees.push(`${entry.relpath}/`);
      else present.add(entry.relpath);
      continue;
    }
    if (entry.kind === "directory") unentered.push(`${entry.relpath}/`);
    else unreadable.add(entry.relpath);
  }
  const beneath = (relpath: string, prefixes: string[]): boolean =>
    prefixes.some((prefix) => relpath.startsWith(prefix));

  const withdrawn: Withdrawal[] = [];
  const carried: string[] = [];
  for (const relpath of Object.keys(previous).sort(compareStrings)) {
    if (emitted.has(relpath)) continue;
    if (
      scan.truncated ||
      unreadable.has(relpath) ||
      beneath(relpath, unentered)
    ) {
      carried.push(relpath);
      continue;
    }
    withdrawn.push({
      relpath,
      reason:
        present.has(relpath) || beneath(relpath, excludedTrees)
          ? "excluded"
          : "absent",
    });
  }
  return { withdrawn, carried };
}

/** The entries a run keeps without deciding anything about them. */
function carriedEntries(
  previous: Record<string, SnapshotEntry>,
  carried: string[],
): Record<string, SnapshotEntry> {
  const kept: Record<string, SnapshotEntry> = {};
  for (const relpath of carried) {
    const entry = previous[relpath];
    if (entry !== undefined) kept[relpath] = entry;
  }
  return kept;
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

/**
 * The record that this page is no longer part of the import. `excluded` says
 * the file is still on the owner's disk and the mapping stopped importing it,
 * so the ledger never claims a deletion that did not happen.
 */
function tombstone(
  withdrawal: Withdrawal,
  observedAt: string,
): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: LEGACY_WIKI_CONNECTOR_ID,
    source_record_id: withdrawal.relpath,
    kind: "page",
    occurred_at: observedAt,
    observed_at: observedAt,
    text: "",
    subjects: [],
    deleted: true,
    attachments: [],
    metadata: {
      relpath: withdrawal.relpath,
      ...(withdrawal.reason === "excluded"
        ? { excluded_by_mapping: true }
        : {}),
    },
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
    const previous = cursor === null ? null : decodeCursor(cursor);
    // A backfill is always a full walk, so it re-emits every page — and a full
    // walk is the most conclusive evidence there is about the ones it did not.
    const { scan, events } = await this.#run([], {});
    return this.#batch(previous, scan, events, events);
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
    // A copy: the snapshot is built from every page the walk planned, and the
    // filtering and the tombstones below are not part of that.
    const kept = changed
      ? [...events]
      : events.filter(
          (event) =>
            hashes.get(event.source_record_id) !==
            previous.files[event.source_record_id]?.hash,
        );
    return this.#batch(previous, scan, events, kept);
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

  /**
   * One batch: the events this run reports, plus a tombstone for every page
   * the snapshot held that the import no longer covers, and a cursor that
   * keeps whatever this walk could not decide about.
   */
  #batch(
    previous: LegacyWikiCursor | null,
    scan: ScanResult,
    planned: CaptureEventInput[],
    reported: CaptureEventInput[],
  ): SyncBatch {
    if (previous === null) {
      return {
        events: reported,
        cursor: encodeCursor(scan, planned, this.mappingHash, {}),
      };
    }
    const emitted = new Set(planned.map((event) => event.source_record_id));
    const { withdrawn, carried } = reconcileSnapshot(
      previous.files,
      scan,
      emitted,
    );
    const observedAt = new Date().toISOString();
    const events = [...reported];
    for (const withdrawal of withdrawn) {
      events.push(tombstone(withdrawal, observedAt));
    }
    events.sort((a, b) =>
      compareStrings(a.source_record_id, b.source_record_id),
    );
    return {
      events,
      cursor: encodeCursor(
        scan,
        planned,
        this.mappingHash,
        carriedEntries(previous.files, carried),
      ),
    };
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
      writeReport(
        {
          path: this.reportPath,
          source: this.path,
          connectorId: LEGACY_WIKI_CONNECTOR_ID,
        },
        report,
        () => renderLegacyWikiReport(report),
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
