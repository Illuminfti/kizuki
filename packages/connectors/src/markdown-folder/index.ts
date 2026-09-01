import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { isPlainObject } from "@kizuki/core";
import { KizukiError } from "../errors";
import {
  compareStrings,
  errorMessage,
  pathHealth,
  requirePathConfig,
} from "../util";

export const MARKDOWN_FOLDER_CONNECTOR_ID = "kizuki.markdown-folder" as const;

export interface MarkdownFolderConfig {
  path: string;
}

interface MarkdownFile {
  content: string;
  mtimeMs: number;
  relpath: string;
  size: number;
}

interface Snapshot {
  files: Record<string, number>;
}

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["file"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
};

export class MarkdownFolderConnector implements Connector {
  readonly path: string;

  constructor(config: MarkdownFolderConfig) {
    this.path = requirePathConfig(config, MARKDOWN_FOLDER_CONNECTOR_ID);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  health() {
    return pathHealth(this.path, "directory");
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    if (cursor !== null) parseSnapshot(cursor);
    const files = await scanMarkdownFiles(this.path);
    const observedAt = new Date().toISOString();
    return {
      events: files.map((file) => fileEvent(file, observedAt)),
      cursor: encodeSnapshot(files),
    };
  }

  async sync(cursor: Cursor | null): Promise<SyncBatch> {
    if (cursor === null) return this.backfill(null);

    const previous = parseSnapshot(cursor);
    const files = await scanMarkdownFiles(this.path);
    const observedAt = new Date().toISOString();
    const currentPaths = new Set(files.map((file) => file.relpath));
    const events = files
      .filter(
        (file) =>
          previous.files[file.relpath] === undefined ||
          file.mtimeMs !== previous.files[file.relpath],
      )
      .map((file) => fileEvent(file, observedAt));

    for (const relpath of Object.keys(previous.files)) {
      if (currentPaths.has(relpath)) continue;
      events.push({
        schema: "kizuki.event/v1",
        connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
        source_record_id: relpath,
        kind: "file",
        occurred_at: observedAt,
        observed_at: observedAt,
        text: "",
        subjects: [],
        deleted: true,
        attachments: [],
        metadata: { relpath },
      });
    }

    events.sort((a, b) => compareStrings(a.source_record_id, b.source_record_id));
    return { events, cursor: encodeSnapshot(files) };
  }

  async revoke(): Promise<void> {}

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return [
      fixtureEvent("journal/2026-01-01.md", "A quiet beginning."),
      fixtureEvent("people/ada.md", "# Ada\n\nMet at the library."),
      fixtureEvent("projects/kizuki.md", "# Kizuki\n\nLocal-first memory."),
    ];
  }
}

export function createMarkdownFolderConnector(
  config: MarkdownFolderConfig,
): MarkdownFolderConnector {
  return new MarkdownFolderConnector(config);
}

async function scanMarkdownFiles(root: string): Promise<MarkdownFile[]> {
  try {
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) {
      throw new KizukiError(
        "misconfigured",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: path is not a directory: ${root}`,
      );
    }
    const files: MarkdownFile[] = [];
    await walk(root, root, files);
    files.sort((a, b) => compareStrings(a.relpath, b.relpath));
    return files;
  } catch (error) {
    if (error instanceof KizukiError) throw error;
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cannot read ${root}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function walk(
  root: string,
  directory: string,
  files: MarkdownFile[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const [info, content] = await Promise.all([
      stat(absolute),
      readFile(absolute, "utf8"),
    ]);
    files.push({
      content,
      mtimeMs: info.mtimeMs,
      relpath: path.relative(root, absolute).split(path.sep).join("/"),
      size: info.size,
    });
  }
}

function fileEvent(file: MarkdownFile, observedAt: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: file.relpath,
    kind: "file",
    occurred_at: new Date(file.mtimeMs).toISOString(),
    observed_at: observedAt,
    text: file.content,
    subjects: [],
    deleted: false,
    attachments: [],
    metadata: { size: file.size, relpath: file.relpath },
  };
}

function fixtureEvent(relpath: string, text: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: relpath,
    kind: "file",
    occurred_at: "2026-01-01T00:00:00.000Z",
    observed_at: "2026-01-01T00:00:00.000Z",
    text,
    subjects: [],
    deleted: false,
    attachments: [],
    metadata: { size: Buffer.byteLength(text), relpath },
  };
}

function encodeSnapshot(files: MarkdownFile[]): Cursor {
  const snapshot: Snapshot = { files: {} };
  for (const file of files) {
    snapshot.files[file.relpath] = file.mtimeMs;
  }
  return JSON.stringify(snapshot);
}

function parseSnapshot(cursor: Cursor): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: malformed cursor`,
      { cause: error },
    );
  }

  if (
    !isPlainObject(parsed) ||
    !isPlainObject(parsed["files"])
  ) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor snapshot`,
    );
  }
  const files: Record<string, number> = {};
  for (const [relpath, mtime] of Object.entries(parsed["files"])) {
    if (typeof mtime !== "number" || !Number.isFinite(mtime)) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor mtime for ${relpath}`,
      );
    }
    files[relpath] = mtime;
  }
  return { files };
}
