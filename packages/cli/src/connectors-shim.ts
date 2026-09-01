// integration: replace with core connectors module
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { HealthReport, isRfc3339 } from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Manifest,
  SyncBatch,
} from "@kizuki/core";

const CONNECTOR_ID = "kizuki.markdown-folder";

export class MarkdownFolderConnector implements Connector {
  private connected = false;
  private readonly sourcePath: string;

  constructor(sourcePath: string) {
    this.sourcePath = resolve(sourcePath);
  }

  manifest(): Manifest {
    return {
      schema: "kizuki.connector/v1",
      connector_id: CONNECTOR_ID,
      version: "0.1.0",
      kinds: ["note"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: false,
        purge: false,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: false,
    };
  }

  async health(): Promise<HealthReport> {
    try {
      const source = await stat(this.sourcePath);
      const usable =
        source.isDirectory() ||
        (source.isFile() && this.sourcePath.endsWith(".md"));
      return new HealthReport({
        state: usable ? "ok" : "misconfigured",
        checked_at: new Date().toISOString(),
        ...(usable ? {} : { detail: "source must be a directory or Markdown file" }),
      });
    } catch {
      return new HealthReport({
        state: "misconfigured",
        checked_at: new Date().toISOString(),
        detail: `source does not exist: ${this.sourcePath}`,
      });
    }
  }

  async connect(_resolve: (secretRef: string) => Promise<string>): Promise<void> {
    const report = await this.health();
    if (report.state !== "ok") {
      throw new Error(report.detail ?? "connector is not healthy");
    }
    this.connected = true;
  }

  async backfill(_cursor: string | null): Promise<SyncBatch> {
    if (!this.connected) throw new Error("connector is not connected");
    const source = await stat(this.sourcePath);
    const files = source.isDirectory()
      ? (await readdir(this.sourcePath))
          .filter((name) => name.endsWith(".md"))
          .sort()
          .map((name) => join(this.sourcePath, name))
      : [this.sourcePath];
    const events: CaptureEventInput[] = [];
    for (const path of files) {
      const file = await stat(path);
      if (!file.isFile()) continue;
      const mtime = file.mtime.toISOString();
      const timestamp = isRfc3339(mtime) ? mtime : new Date().toISOString();
      const relativePath = source.isDirectory()
        ? relative(this.sourcePath, path)
        : basename(path);
      events.push({
        schema: "kizuki.event/v1",
        connector_id: CONNECTOR_ID,
        source_record_id: relativePath,
        kind: "note",
        occurred_at: timestamp,
        observed_at: timestamp,
        text: await readFile(path, "utf8"),
        subjects: [],
        deleted: false,
        attachments: [],
        metadata: { path: relativePath },
      });
    }
    return { events, cursor: null };
  }

  async sync(_cursor: string | null): Promise<SyncBatch> {
    if (!this.connected) throw new Error("connector is not connected");
    return { events: [], cursor: null };
  }

  async revoke(): Promise<void> {
    this.connected = false;
  }

  async purgeSource(subjectId: string): Promise<{
    subject_id: string;
    source_record_ids: string[];
    unreachable_source_record_ids: string[];
  }> {
    return {
      subject_id: subjectId,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return [
      {
        schema: "kizuki.event/v1",
        connector_id: CONNECTOR_ID,
        source_record_id: "fixture.md",
        kind: "note",
        occurred_at: "2026-01-01T00:00:00Z",
        observed_at: "2026-01-01T00:00:00Z",
        text: "# Fixture\n\nA local Markdown note.\n",
        subjects: [],
        deleted: false,
        attachments: [],
        metadata: { path: "fixture.md" },
      },
    ];
  }
}
