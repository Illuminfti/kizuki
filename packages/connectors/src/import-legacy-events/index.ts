import { freezeManifest, HealthReport, policyForConnector } from "@kizuki/core";
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
import { pathHealth, requirePathConfig } from "../util";
import {
  LEGACY_EVENTS_FIXTURE,
  LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
  fixtureMappingHash,
  fixtureRows,
} from "./fixture";
import {
  LEGACY_EVENTS_CURSOR_SCHEMA,
  decodeCursor,
  emptyTotals,
} from "./cursor";
import type { LegacyEventsCursor } from "./cursor";
import {
  LEGACY_EVENTS_CONNECTOR_ID,
  consumedColumns,
  kindsOf,
  parseLegacyEventsMapping,
} from "./mapping";
import type {
  LegacyEventsConfig,
  LegacyEventsMapping,
  SourceFormat,
} from "./mapping";
import {
  LEGACY_EVENTS_REPORT_SCHEMA,
  MAX_REPORTED_SKIPS,
  renderLegacyEventsReport,
} from "./report";
import type { LegacyEventsReport } from "./report";
import { rowToEvent } from "./rows";
import { BATCH_ROWS, openJsonlSource, openSqliteSource } from "./source";
import type { LegacyRowSource } from "./source";

/**
 * An importer for a previous event table, not live sync: it pages once through
 * an export the owner already has. A row edited in place after it was imported
 * stays invisible until the owner re-imports from scratch, and the docs say so.
 */

function detectFormat(path: string, declared?: SourceFormat): SourceFormat {
  if (declared !== undefined) return declared;
  if (/\.(?:db|sqlite|sqlite3)$/i.test(path)) return "sqlite";
  if (/\.(?:jsonl|ndjson)$/i.test(path)) return "jsonl";
  throw new KizukiError(
    "misconfigured",
    `${LEGACY_EVENTS_CONNECTOR_ID}: config.format is required for ${path}`,
  );
}

export class LegacyEventsConnector implements Connector {
  readonly path: string;
  readonly format: SourceFormat;
  readonly mapping: LegacyEventsMapping;
  readonly mappingHash: string;
  readonly reportPath: string | null;
  #report: LegacyEventsReport | null = null;
  #skipped = 0;

  constructor(config: LegacyEventsConfig) {
    this.path = requirePathConfig(config, LEGACY_EVENTS_CONNECTOR_ID);
    this.format = detectFormat(this.path, config.format);
    const loaded = loadMapping(
      config.mapping,
      defaultMappingPath(this.path, "file"),
      LEGACY_EVENTS_CONNECTOR_ID,
    );
    this.mapping = parseLegacyEventsMapping(loaded.raw, this.format);
    this.mappingHash = loaded.hash;
    this.reportPath = resolveReportPath(
      config.report,
      this.path,
      LEGACY_EVENTS_CONNECTOR_ID,
    );
  }

  manifest(): Manifest {
    // Instance-derived: this connector emits exactly the kinds the owner's
    // mapping can produce, plus the fixture's, and nothing else.
    const kinds = new Set([
      ...kindsOf(this.mapping),
      ...kindsOf(LEGACY_EVENTS_FIXTURE.mapping),
    ]);
    return freezeManifest({
      schema: "kizuki.connector/v1",
      connector_id: LEGACY_EVENTS_CONNECTOR_ID,
      version: "0.1.0",
      contract_minor: 1,
      implementation: "@kizuki/connectors",
      allowed_egress: [],
      cursor_schema: LEGACY_EVENTS_CURSOR_SCHEMA,
      kinds: [...kinds].sort(),
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: this.mapping.deleted !== null,
        purge: false,
        fixture: true,
      },
      required_secrets: [],
      // Every row leaves with a label, mapped or defaulted at the floor.
      emits_sensitivity_hint: true,
      ...policyForConnector(LEGACY_EVENTS_CONNECTOR_ID),
      auth_modes: ["none"],
    });
  }

  async health(): Promise<HealthReport> {
    const base = await pathHealth(this.path, "file");
    if (base.state !== "ok" || this.#skipped === 0) return base;
    return new HealthReport({
      state: "degraded",
      checked_at: base.checked_at,
      detail: `${this.#skipped} row(s) skipped; see the report`,
    });
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    const previous = cursor === null ? null : decodeCursor(cursor);
    const source = this.#open();
    try {
      return this.#page(source, previous);
    } finally {
      source.close();
    }
  }

  /** Rows appended since the last position are new evidence; nothing else is. */
  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(_subject_id: string): Promise<PurgePlan> {
    return notSupported(LEGACY_EVENTS_CONNECTOR_ID, "purge");
  }

  async fixture(): Promise<CaptureEventInput[]> {
    const events: CaptureEventInput[] = [];
    for (const row of fixtureRows()) {
      const result = rowToEvent(row, LEGACY_EVENTS_FIXTURE.mapping, {
        observedAt: LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
        mappingHash: fixtureMappingHash(),
      });
      if ("event" in result) events.push(result.event);
    }
    return events;
  }

  lastReport(): LegacyEventsReport | null {
    return this.#report;
  }

  #open(): LegacyRowSource {
    return this.format === "sqlite"
      ? openSqliteSource(this.path, this.mapping.table as string)
      : openJsonlSource(this.path);
  }

  #page(
    source: LegacyRowSource,
    previous: LegacyEventsCursor | null,
  ): SyncBatch {
    this.#assertColumns(source);
    let restarted: LegacyEventsReport["run"]["restarted"] = null;
    let from = previous === null ? 0n : BigInt(previous.position);
    if (previous !== null) {
      if (previous.mapping_hash !== this.mappingHash) {
        restarted = "mapping_changed";
        from = 0n;
      } else if (from > source.size()) {
        // A rewritten export is a different export; resume would skip rows.
        restarted = "source_shrank";
        from = 0n;
      }
    }

    const rows = source.read(from, BATCH_ROWS);
    const events: CaptureEventInput[] = [];
    // A restart abandons what the previous pages counted; it is a new run.
    const totals =
      previous === null || restarted !== null
        ? emptyTotals(from)
        : previous.run;
    for (const row of rows) {
      const result = rowToEvent(row, this.mapping, {
        observedAt: new Date().toISOString(),
        mappingHash: this.mappingHash,
      });
      totals.counts.rows += 1;
      if ("skipped" in result) {
        totals.counts.skipped += 1;
        if (totals.skipped.length < MAX_REPORTED_SKIPS) {
          totals.skipped.push(result.skipped);
        }
        continue;
      }
      events.push(result.event);
      totals.counts.events += 1;
      const kind = result.event.kind;
      totals.counts.kinds[kind] = (totals.counts.kinds[kind] ?? 0) + 1;
      if (result.event.deleted) totals.counts.tombstones += 1;
      const dropped = result.event.metadata["__blobs"];
      if (Array.isArray(dropped)) totals.counts.blobs_dropped += dropped.length;
    }

    const done = rows.length < BATCH_ROWS;
    const to = rows[rows.length - 1]?.position ?? from;
    const cursor: LegacyEventsCursor = {
      schema: LEGACY_EVENTS_CURSOR_SCHEMA,
      mapping_hash: this.mappingHash,
      position: to.toString(),
      done,
      run: totals,
    };

    this.#skipped = totals.counts.skipped;
    this.#report = {
      schema: LEGACY_EVENTS_REPORT_SCHEMA,
      generated_at: new Date().toISOString(),
      mapping_hash: this.mappingHash,
      format: this.format,
      run: {
        from_position: totals.from_position,
        to_position: to.toString(),
        done,
        restarted,
      },
      counts: totals.counts,
      skipped: totals.skipped,
      columns: {
        consumed: [...consumedColumns(this.mapping)].sort(),
        metadata: this.mapping.metadata.columns,
        unknown_in_mapping: this.#unknownColumns(source),
      },
    };
    if (this.reportPath !== null) {
      const report = this.#report;
      writeReport(
        {
          path: this.reportPath,
          source: this.path,
          connectorId: LEGACY_EVENTS_CONNECTOR_ID,
        },
        report,
        () => renderLegacyEventsReport(report),
      );
    }
    return { events, cursor: JSON.stringify(cursor) };
  }

  #unknownColumns(source: LegacyRowSource): string[] {
    if (source.columns === null) return [];
    const present = new Set(source.columns);
    const named = new Set([...consumedColumns(this.mapping)]);
    if (this.mapping.metadata.columns !== "rest") {
      for (const column of this.mapping.metadata.columns) named.add(column);
    }
    return [...named].filter((column) => !present.has(column)).sort();
  }

  /** A mapping that names a column the table does not have is a refusal, not
   * a run that quietly imports empty fields. */
  #assertColumns(source: LegacyRowSource): void {
    const missing = this.#unknownColumns(source);
    if (missing.length > 0) {
      throw new KizukiError(
        "misconfigured",
        `${LEGACY_EVENTS_CONNECTOR_ID}: mapping names columns the source does not have: ${missing.join(", ")}`,
      );
    }
  }
}

export function createLegacyEventsConnector(
  config: LegacyEventsConfig,
): LegacyEventsConnector {
  return new LegacyEventsConnector(config);
}

export {
  IDENTIFIER,
  KIND,
  LEGACY_EVENTS_CONNECTOR_ID,
  LEGACY_EVENTS_MAPPING_SCHEMA,
  consumedColumns,
  kindsOf,
  parseLegacyEventsMapping,
} from "./mapping";
export type {
  LegacyEventsConfig,
  LegacyEventsMapping,
  SourceFormat,
} from "./mapping";
export { LEGACY_EVENTS_FIXTURE, fixtureRows } from "./fixture";
export {
  LEGACY_EVENTS_REPORT_SCHEMA,
  renderLegacyEventsReport,
} from "./report";
export type { LegacyEventsReport } from "./report";
export { rowToEvent } from "./rows";
export type { RowSkip, RowSkipReason } from "./rows";
export { BATCH_ROWS, openJsonlSource, openSqliteSource } from "./source";
export { LEGACY_EVENTS_CURSOR_SCHEMA } from "./cursor";
export type { LegacyRow, LegacyRowSource } from "./source";
