import { HealthReport } from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import {
  FIXTURE_OBSERVED_AT,
  compareStrings,
  errorMessage,
  requireKnownKeys,
  requirePathConfig,
} from "../util";
import {
  OMNIVORE_IMPORT_CONNECTOR_ID,
  fsOmnivoreFiles,
  mapOmnivoreFiles,
  omnivoreEvents,
} from "./parse";

export {
  OMNIVORE_IMPORT_CONNECTOR_ID,
  fsOmnivoreFiles,
  mapOmnivoreFiles,
  omnivoreEvents,
  parseOmnivoreMetadata,
} from "./parse";
export type { OmnivoreFiles, OmnivoreItem } from "./parse";

export interface OmnivoreImportConfig {
  /** The unzipped export directory. */
  path: string;
}

const CONFIG_KEYS = ["path"];

const FIXTURE_METADATA = [
  {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    slug: "local-first-software",
    title: "Local-first software",
    description: "Why data should live on the owner's disk.",
    author: "grace",
    url: "https://example.com/local-first-software",
    state: "Active",
    labels: ["software", "reading"],
    savedAt: "2026-01-01T09:00:00Z",
    updatedAt: "2026-02-01T09:00:00Z",
    readingProgress: 41.5,
    publishedAt: "2025-12-30T00:00:00Z",
  },
  {
    id: "a1b2c3d4-0000-4000-8000-000000000002",
    slug: "quartz-heron-notes",
    title: "Quartz heron notes",
    description: "Field notes on a quartz heron.",
    url: "https://example.com/quartz-heron-notes",
    state: "Archived",
    labels: [{ name: "birds" }],
    savedAt: "2026-01-02T10:00:00+02:00",
  },
  {
    id: "a1b2c3d4-0000-4000-8000-000000000003",
    slug: "acme-launch-plan",
    title: "Acme launch plan",
    description: "",
    url: "https://example.com/acme-launch-plan",
    state: "Active",
    labels: [],
    savedAt: "2026-01-03T09:00:00Z",
  },
];

export const OMNIVORE_FIXTURE_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    "metadata_0_to_3.json": `${JSON.stringify(FIXTURE_METADATA, null, 2)}\n`,
    "highlights/local-first-software.md":
      "## Highlights\n\n> Data stays under your control.\n\nNote: relevant for acme.\n",
    "content/local-first-software.html":
      "<html><body><p>fixture</p></body></html>",
    "content/quartz-heron-notes.html": "<html><body><p>heron</p></body></html>",
  });

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: OMNIVORE_IMPORT_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["bookmark"],
  capabilities: {
    backfill: true,
    sync: true,
    // An item missing from a later export may have been deleted, or the
    // export may simply be narrower. The importer does not guess.
    tombstones: false,
    purge: true,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none"],
};

export class OmnivoreImportConnector implements Connector {
  readonly path: string;

  constructor(config: OmnivoreImportConfig) {
    this.path = requirePathConfig(config, OMNIVORE_IMPORT_CONNECTOR_ID);
    requireKnownKeys(config, OMNIVORE_IMPORT_CONNECTOR_ID, CONFIG_KEYS);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async health(): Promise<HealthReport> {
    const checked_at = new Date().toISOString();
    try {
      await fsOmnivoreFiles(this.path);
      return new HealthReport({ state: "ok", checked_at });
    } catch (error) {
      return new HealthReport({
        state: "misconfigured",
        checked_at,
        detail: errorMessage(error),
      });
    }
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(_cursor: Cursor | null): Promise<SyncBatch> {
    return { events: await this.read(), cursor: null };
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    const events = await this.read();
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: events
        .filter((event) =>
          event.subjects.some((subject) => subject.subject_id === subject_id),
        )
        .map((event) => event.source_record_id)
        .sort(compareStrings),
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return omnivoreEvents(
      mapOmnivoreFiles(OMNIVORE_FIXTURE_FILES),
      FIXTURE_OBSERVED_AT,
    );
  }

  private async read(): Promise<CaptureEventInput[]> {
    return omnivoreEvents(
      await fsOmnivoreFiles(this.path),
      new Date().toISOString(),
    );
  }
}

export function createOmnivoreImportConnector(
  config: OmnivoreImportConfig,
): OmnivoreImportConnector {
  return new OmnivoreImportConnector(config);
}
