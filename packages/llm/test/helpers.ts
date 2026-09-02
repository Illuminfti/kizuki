import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initVault, openLedger } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import type { CaptureEvent } from "@kizuki/core";
import { LLM_CONFIG_DEFAULTS } from "../src/config";
import type { LlmConfig } from "../src/config";
import type { Clock } from "../src/client";

export function tempVault(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), "kizuki-llm-"));
  initVault(path);
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ...LLM_CONFIG_DEFAULTS,
    base_url: "http://127.0.0.1:11434/v1",
    model: "fixture-model",
    api_key_ref: null,
    ...overrides,
  };
}

export interface FakeClock extends Clock {
  slept: number[];
  advance: (ms: number) => void;
}

/** Deterministic time: sleeping moves the clock instead of the wall. */
export function fakeClock(start = 1_000_000): FakeClock {
  let at = start;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
  };
}

export function memoryDb(): Database {
  const db = openLedger(":memory:");
  initStaging(db);
  return db;
}

export function event(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    schema: "kizuki.event/v1",
    event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    connector_id: "markdown-folder",
    source_record_id: "notes/a.md",
    kind: "note",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "ada met grace at the acme library",
    subjects: [
      { subject_id: "person:ada", role: "from", display_name: "ada" },
      { subject_id: "person:grace", role: "about" },
    ],
    deleted: false,
    attachments: [],
    metadata: {},
    content_hash: "b".repeat(64),
    ...overrides,
  };
}
