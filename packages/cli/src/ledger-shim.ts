// integration: replace with core ledger module
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  computeContentHash,
  ulid,
  validateEventInput,
} from "@kizuki/core";
import type { CaptureEvent, CaptureEventInput } from "@kizuki/core";
import { assertVault } from "./vault-shim";

export type AcceptResult = "stored" | "duplicate" | "error";

interface EventRow {
  attachments_json: string;
  connector_id: string;
  content_hash: string;
  deleted: number;
  event_id: string;
  kind: string;
  metadata_json: string;
  observed_at: string;
  occurred_at: string;
  sensitivity_hint: string | null;
  source_record_id: string;
  subjects_json: string;
  text: string;
}

function rowToEvent(row: EventRow): CaptureEvent {
  return {
    schema: "kizuki.event/v1",
    event_id: row.event_id,
    connector_id: row.connector_id,
    source_record_id: row.source_record_id,
    kind: row.kind,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    text: row.text,
    subjects: JSON.parse(row.subjects_json),
    ...(row.sensitivity_hint === null
      ? {}
      : {
          sensitivity_hint: row.sensitivity_hint as
            | "public"
            | "personal"
            | "private",
        }),
    deleted: row.deleted === 1,
    attachments: JSON.parse(row.attachments_json),
    metadata: JSON.parse(row.metadata_json),
    content_hash: row.content_hash,
  };
}

export class Ledger {
  private readonly database: Database;

  constructor(vaultPath: string) {
    const absolutePath = assertVault(vaultPath);
    this.database = new Database(join(absolutePath, ".kizuki", "kizuki.db"), {
      create: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        text TEXT NOT NULL,
        subjects_json TEXT NOT NULL,
        sensitivity_hint TEXT,
        deleted INTEGER NOT NULL,
        attachments_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(connector_id, source_record_id, content_hash)
      )
    `);
  }

  close(): void {
    this.database.close();
  }

  accept(input: CaptureEventInput): AcceptResult {
    const validation = validateEventInput(input);
    if (!validation.ok) return "error";

    try {
      const event = validation.value;
      const contentHash = computeContentHash(event);
      this.database
        .query(`
          INSERT INTO events (
            event_id, connector_id, source_record_id, kind, occurred_at,
            observed_at, text, subjects_json, sensitivity_hint, deleted,
            attachments_json, metadata_json, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          ulid(),
          event.connector_id,
          event.source_record_id,
          event.kind,
          event.occurred_at,
          event.observed_at,
          event.text,
          JSON.stringify(event.subjects),
          event.sensitivity_hint ?? null,
          event.deleted ? 1 : 0,
          JSON.stringify(event.attachments),
          JSON.stringify(event.metadata),
          contentHash,
        );
      return "stored";
    } catch {
      try {
        const contentHash = computeContentHash(validation.value);
        const duplicate = this.database
          .query(
            "SELECT 1 AS present FROM events WHERE connector_id = ? AND source_record_id = ? AND content_hash = ?",
          )
          .get(
            validation.value.connector_id,
            validation.value.source_record_id,
            contentHash,
          );
        return duplicate === null ? "error" : "duplicate";
      } catch {
        return "error";
      }
    }
  }

  findAccepted(input: CaptureEventInput): CaptureEvent | undefined {
    const validation = validateEventInput(input);
    if (!validation.ok) return undefined;
    const row = this.database
      .query(
        "SELECT * FROM events WHERE connector_id = ? AND source_record_id = ? AND content_hash = ?",
      )
      .get(
        validation.value.connector_id,
        validation.value.source_record_id,
        computeContentHash(validation.value),
      ) as EventRow | null;
    return row === null ? undefined : rowToEvent(row);
  }

  count(): number {
    const row = this.database.query("SELECT COUNT(*) AS count FROM events").get() as {
      count: number;
    };
    return row.count;
  }

  searchText(query: string): CaptureEvent[] {
    const rows = this.database
      .query("SELECT * FROM events WHERE text LIKE ? ORDER BY event_id")
      .all(`%${query}%`) as EventRow[];
    return rows.map(rowToEvent);
  }

  lastEvents(limit: number): CaptureEvent[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    const rows = this.database
      .query("SELECT * FROM events ORDER BY rowid DESC LIMIT ?")
      .all(safeLimit) as EventRow[];
    return rows.map(rowToEvent);
  }
}
