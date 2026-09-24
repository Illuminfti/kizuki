import {
  HealthReport,
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  PAGE_CANDIDATE_KEY,
  freezeManifest,
  isPlainObject,
  policyForConnector,
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
import { KizukiError, notSupported } from "../errors";
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

/** Discovery can inspect authentication before an owner supplies the mapping. */
export const LEGACY_WIKI_AUTH_MODES = Object.freeze(["none"] as const);

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: LEGACY_WIKI_CONNECTOR_ID,
  version: "0.1.0",
  contract_minor: 1,
  implementation: "@kizuki/connectors",
  allowed_egress: [],
  cursor_schema: LEGACY_WIKI_CURSOR_SCHEMA,
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
  ...policyForConnector(LEGACY_WIKI_CONNECTOR_ID),
  auth_modes: [...LEGACY_WIKI_AUTH_MODES],
});

export interface LegacyWikiIdentity {
  /**
   * So an edited page is re-emitted and a copied wiki with fresh mtimes is
   * not. Empty when the ledger row predates page hashes: it matches no page,
   * so that page is re-emitted once and carries its hash from then on.
   */
  hash: string;
  /** So a page added later cannot take a target this page is already staged at. */
  target: string;
}

/** Factory-only. Never serialized into connection config or protected state. */
export interface LegacyWikiDeps {
  /**
   * Latest live `[relpath, {hash,target}]` identities for this source.
   * Called when the resume cursor cannot carry the snapshot inside
   * `MAX_CURSOR_BYTES`.
   */
  committedFiles?: () =>
    | ReadonlyArray<readonly [string, LegacyWikiIdentity]>
    | Promise<ReadonlyArray<readonly [string, LegacyWikiIdentity]>>;
}

interface LegacyWikiCursor {
  schema: typeof LEGACY_WIKI_CURSOR_SCHEMA;
  mapping_hash: string;
  after: string | null;
  exhausted: boolean;
  /** Every page the ledger still holds a record for: the ones this run
   * emitted, plus the ones it could not read and therefore could not decide
   * anything about. A page dropped from here can never be withdrawn again.
   * Omitted from the wire form when the map would exceed MAX_CURSOR_BYTES. */
  files: Record<string, LegacyWikiIdentity>;
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

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function sortedFiles(
  files: Record<string, LegacyWikiIdentity>,
): Record<string, LegacyWikiIdentity> {
  const sorted: Record<string, LegacyWikiIdentity> = {};
  for (const relpath of Object.keys(files).sort(compareStrings)) {
    const entry = files[relpath];
    if (entry !== undefined) sorted[relpath] = entry;
  }
  return sorted;
}

function encodeCursor(
  mappingHash: string,
  files: Record<string, LegacyWikiIdentity>,
  after: string | null,
  exhausted: boolean,
): Cursor {
  const body = {
    schema: LEGACY_WIKI_CURSOR_SCHEMA,
    mapping_hash: mappingHash,
    after,
    exhausted,
    files: sortedFiles(files),
  };
  const withFiles = JSON.stringify(body);
  if (utf8Bytes(withFiles) <= MAX_CURSOR_BYTES) return withFiles;
  const { files: _files, ...compact } = body;
  return JSON.stringify(compact);
}

function takePage(events: readonly CaptureEventInput[]): {
  page: CaptureEventInput[];
  rest: CaptureEventInput[];
} {
  const page: CaptureEventInput[] = [];
  let encoded = 2;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) break;
    const extra = utf8Bytes(JSON.stringify(event)) + (page.length === 0 ? 0 : 1);
    if (page.length === 0 && encoded + extra > MAX_SYNC_BATCH_BYTES) {
      throw new KizukiError(
        "parse_error",
        `${LEGACY_WIKI_CONNECTOR_ID}: event exceeds the capture page bound`,
      );
    }
    if (
      page.length > 0 &&
      (page.length >= MAX_SYNC_BATCH_EVENTS ||
        encoded + extra > MAX_SYNC_BATCH_BYTES)
    ) {
      return { page, rest: events.slice(index) };
    }
    page.push(event);
    encoded += extra;
  }
  return { page, rest: [] };
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
  previous: Record<string, LegacyWikiIdentity>,
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
  previous: Record<string, LegacyWikiIdentity>,
  carried: string[],
): Record<string, LegacyWikiIdentity> {
  const kept: Record<string, LegacyWikiIdentity> = {};
  for (const relpath of carried) {
    const entry = previous[relpath];
    if (entry !== undefined) kept[relpath] = entry;
  }
  return kept;
}

function isLegacyWikiIdentity(raw: unknown): raw is LegacyWikiIdentity {
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
    typeof parsed["mapping_hash"] !== "string"
  ) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_WIKI_CONNECTOR_ID}: malformed cursor`,
    );
  }
  const hasFiles = Object.hasOwn(parsed, "files");
  const filesRaw = parsed["files"];
  if (
    hasFiles &&
    (!isPlainObject(filesRaw) ||
      !Object.values(filesRaw).every(isLegacyWikiIdentity))
  ) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_WIKI_CONNECTOR_ID}: malformed cursor`,
    );
  }
  const hasAfter = Object.hasOwn(parsed, "after");
  const afterRaw = parsed["after"];
  if (hasAfter && afterRaw !== null && typeof afterRaw !== "string") {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_WIKI_CONNECTOR_ID}: malformed cursor`,
    );
  }
  const hasExhausted = Object.hasOwn(parsed, "exhausted");
  const exhaustedRaw = parsed["exhausted"];
  if (hasExhausted && typeof exhaustedRaw !== "boolean") {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_WIKI_CONNECTOR_ID}: malformed cursor`,
    );
  }
  return {
    schema: LEGACY_WIKI_CURSOR_SCHEMA,
    mapping_hash: parsed["mapping_hash"],
    after: typeof afterRaw === "string" ? afterRaw : null,
    exhausted: hasExhausted ? exhaustedRaw === true : !hasAfter,
    files: hasFiles ? (filesRaw as Record<string, LegacyWikiIdentity>) : {},
  };
}

function pinnedTargets(
  files: Record<string, LegacyWikiIdentity>,
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
  readonly #committedFiles: LegacyWikiDeps["committedFiles"];
  #report: LegacyWikiReport | null = null;
  #degraded = 0;

  constructor(config: LegacyWikiConfig, deps: LegacyWikiDeps = {}) {
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
    this.#committedFiles = deps.committedFiles;
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
    // A fresh sweep emits every page. A returned snapshot resumes through the
    // same path as sync, so a host draining batches can reach exhaustion.
    if (cursor !== null) return this.sync(cursor);
    return this.#sweep(null);
  }

  async sync(cursor: Cursor | null): Promise<SyncBatch> {
    if (cursor === null) return this.backfill(null);
    return this.#sweep(cursor);
  }

  async revoke(): Promise<void> {}

  /** The wiki files are the owner's own; purge is a ledger-side operation. */
  async purgeSource(_subject_id: string): Promise<PurgePlan> {
    return notSupported(LEGACY_WIKI_CONNECTOR_ID, "purge");
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

  async #identities(
    previous: LegacyWikiCursor | null,
  ): Promise<Record<string, LegacyWikiIdentity>> {
    if (previous !== null && Object.keys(previous.files).length > 0) {
      return { ...previous.files };
    }
    if (this.#committedFiles === undefined) {
      return previous === null ? {} : { ...previous.files };
    }
    const rows = await this.#committedFiles();
    const files: Record<string, LegacyWikiIdentity> = {};
    for (const [relpath, entry] of rows) files[relpath] = entry;
    return files;
  }

  /**
   * One bounded page: changed pages after the resume point, then tombstones
   * once the walk has named every current page. The cursor stays inside
   * MAX_CURSOR_BYTES by dropping the identity map when it no longer fits.
   */
  async #sweep(cursor: Cursor | null): Promise<SyncBatch> {
    const previous = cursor === null ? null : decodeCursor(cursor);
    const identities = await this.#identities(previous);
    const mappingChanged =
      previous !== null && previous.mapping_hash !== this.mappingHash;
    const { scan, events: planned } = await this.#run(
      mappingChanged ? ["mapping_changed"] : [],
      mappingChanged ? {} : pinnedTargets(identities),
    );
    const hashes = new Map(
      scan.files.map((file) => [file.relpath, contentHash(file.content)]),
    );
    const after = previous?.after ?? null;
    const paging = previous !== null && !previous.exhausted && !mappingChanged;
    const candidates = (
      previous === null || mappingChanged
        ? planned
        : paging
          ? planned.filter(
              (event) =>
                after === null ||
                compareStrings(event.source_record_id, after) > 0,
            )
          : planned.filter(
              (event) =>
                hashes.get(event.source_record_id) !==
                identities[event.source_record_id]?.hash,
            )
    ).sort((left, right) =>
      compareStrings(left.source_record_id, right.source_record_id),
    );
    const { page, rest } = takePage(candidates);
    const filesDone = rest.length === 0;
    const nextFiles: Record<string, LegacyWikiIdentity> = { ...identities };

    let events = [...page];
    let withdrawalsRemain = false;
    if (filesDone && previous !== null && (previous.exhausted || paging)) {
      const emitted = new Set(planned.map((event) => event.source_record_id));
      const { withdrawn, carried } = reconcileSnapshot(
        identities,
        scan,
        emitted,
      );
      const observedAt = new Date().toISOString();
      const tombstones = withdrawn.map((withdrawal) =>
        tombstone(withdrawal, observedAt),
      );
      const paged = takePage([...page, ...tombstones]);
      events = paged.page;
      withdrawalsRemain = paged.rest.length > 0;
      Object.assign(nextFiles, carriedEntries(identities, carried));
    }

    for (const event of events) {
      if (event.deleted) {
        delete nextFiles[event.source_record_id];
        continue;
      }
      const hash = hashes.get(event.source_record_id);
      const target = targetOf(event);
      if (hash === undefined || target === null) continue;
      nextFiles[event.source_record_id] = { hash, target };
    }

    const last = events[events.length - 1];
    const exhausted = filesDone && !withdrawalsRemain;
    const nextAfter = exhausted
      ? null
      : (last?.source_record_id ?? after);
    return {
      events,
      cursor: encodeCursor(this.mappingHash, nextFiles, nextAfter, exhausted),
      has_more: !exhausted,
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
  deps: LegacyWikiDeps = {},
): LegacyWikiConnector {
  return new LegacyWikiConnector(config, deps);
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
