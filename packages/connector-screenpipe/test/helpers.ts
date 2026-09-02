import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FIXTURE_MIGRATIONS,
  seedFixtureDatabase,
} from "../src/fixture";
import type { ScreenpipeDeps } from "../src/config";

export interface FixtureDatabase {
  dir: string;
  path: string;
  writer: Database;
}

const tempDirectories = new Set<string>();

export function createFixtureDatabase(options?: {
  migrations?: readonly number[];
  rows?: boolean;
}): FixtureDatabase {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kizuki-screenpipe-"));
  tempDirectories.add(dir);
  const databasePath = path.join(dir, "db.sqlite");
  const writer = new Database(databasePath, { safeIntegers: true });
  seedFixtureDatabase(writer, {
    migrations: options?.migrations ?? FIXTURE_MIGRATIONS,
    rows: options?.rows ?? true,
  });
  return { dir, path: databasePath, writer };
}

export function closeAndRemove(fixture: FixtureDatabase): void {
  try {
    fixture.writer.close();
  } catch {
    // A test may deliberately close the writer before this cleanup boundary.
  }
  rmSync(fixture.dir, { recursive: true, force: true });
  tempDirectories.delete(fixture.dir);
}

export function cleanupFixtureDatabases(): void {
  for (const dir of tempDirectories) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirectories.clear();
}

export function fixtureDeps(
  now: string,
  open?: ScreenpipeDeps["open"],
): Partial<ScreenpipeDeps> {
  return {
    now: () => Date.parse(now),
    ...(open === undefined ? {} : { open }),
  };
}

export function insertFrame(
  writer: Database,
  values: {
    id?: number | bigint;
    timestamp: string;
    fullText?: string | null;
    appName?: string | null;
    browserUrl?: string | null;
  },
): void {
  writer
    .query(
      `INSERT INTO frames
         (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
          browser_url, device_name, focused, full_text, text_source,
          capture_trigger, snapshot_path, document_path)
       VALUES (?, NULL, 0, ?, ?, NULL, ?, 'Fixture Display', 1, ?,
               'accessibility', 'fixture', NULL, NULL)`,
    )
    .run(
      values.id ?? null,
      values.timestamp,
      values.appName ?? "Fixture App",
      values.browserUrl ?? null,
      values.fullText === undefined ? "fixture text" : values.fullText,
    );
}

export function insertTranscription(
  writer: Database,
  values: {
    id?: number | bigint;
    timestamp: string;
    transcription?: string;
    device?: string;
    speakerId?: number | null;
  },
): void {
  writer
    .query(
      `INSERT INTO audio_transcriptions
         (id, audio_chunk_id, offset_index, timestamp, transcription, device,
          is_input_device, speaker_id, transcription_engine, start_time, end_time)
       VALUES (?, 1, 0, ?, ?, ?, 1, ?, 'fixture-engine', 0, 1)`,
    )
    .run(
      values.id ?? null,
      values.timestamp,
      values.transcription ?? "fixture transcript",
      values.device ?? "Fixture Microphone",
      values.speakerId ?? null,
    );
}
