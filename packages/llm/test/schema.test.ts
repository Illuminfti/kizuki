import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { PROMPT_VERSION } from "../src/prompt";
import {
  completedProducers,
  initLlm,
  insertRun,
  lastRun,
  listRuns,
  recordEnrichment,
  sweepOrphans,
} from "../src/schema";
import type { EnrichmentOutcome, LlmRun } from "../src/schema";
import { memoryDb } from "./helpers";

let db: Database | undefined;

function open(): Database {
  db = memoryDb();
  return db;
}

afterEach(() => {
  db?.close();
  db = undefined;
});

function tables(database: Database): string[] {
  return database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function run(overrides: Partial<LlmRun> = {}): LlmRun {
  return {
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
    started_at: "2026-03-01T00:00:00.000Z",
    finished_at: "2026-03-01T00:00:01.000Z",
    endpoint_host: "127.0.0.1:11434",
    model: "fixture-model",
    prompt_version: PROMPT_VERSION,
    producers: ["summary"],
    considered: 3,
    sent: 1,
    skipped_unlabeled: 1,
    skipped_ceiling: 0,
    skipped_done: 1,
    skipped_short: 0,
    skipped_existing: 0,
    requests: 1,
    input_chars: 120,
    output_chars: 40,
    prompt_tokens: 11,
    completion_tokens: 7,
    proposals_filed: 1,
    duplicates: 0,
    suppressed: 0,
    rejected_outputs: 0,
    empty_outputs: 0,
    errors: 0,
    orphans_swept: 0,
    stopped: "complete",
    ...overrides,
  };
}

describe("initLlm", () => {
  test("creates both tables and can be called again", () => {
    const database = open();
    initLlm(database);
    initLlm(database);
    expect(tables(database)).toContain("llm_enrichments");
    expect(tables(database)).toContain("llm_runs");
  });

  test("the tables are STRICT", () => {
    const database = open();
    initLlm(database);
    expect(() =>
      database
        .query(
          "INSERT INTO llm_runs (run_id, started_at, considered) VALUES (?, ?, ?)",
        )
        .run("r1", "now", "not-a-number"),
    ).toThrow();
  });
});

describe("lastRun", () => {
  test("is null on a database that never ran enrichment, and creates nothing", () => {
    const database = open();
    const before = tables(database);
    expect(lastRun(database)).toBeNull();
    expect(tables(database)).toEqual(before);
    expect(before).not.toContain("llm_runs");
  });

  test("is null when the table exists but is empty", () => {
    const database = open();
    initLlm(database);
    expect(lastRun(database)).toBeNull();
  });

  test("returns the newest row, round-tripped", () => {
    const database = open();
    initLlm(database);
    const older = run();
    const newer = run({
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      started_at: "2026-03-02T00:00:00.000Z",
      producers: ["summary", "entities", "claims"],
      prompt_tokens: null,
      completion_tokens: null,
      stopped: "budget",
    });
    insertRun(database, older);
    insertRun(database, newer);
    expect(lastRun(database)).toEqual(newer);
  });
});

describe("listRuns", () => {
  test("is newest first and respects the limit", () => {
    const database = open();
    initLlm(database);
    for (let index = 1; index <= 4; index += 1) {
      insertRun(
        database,
        run({
          run_id: `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
          started_at: `2026-03-0${index}T00:00:00.000Z`,
        }),
      );
    }
    expect(listRuns(database).map((entry) => entry.started_at)).toEqual([
      "2026-03-04T00:00:00.000Z",
      "2026-03-03T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
    expect(listRuns(database, { limit: 2 })).toHaveLength(2);
  });

  test("is empty when the table is absent", () => {
    expect(listRuns(open())).toEqual([]);
  });
});

describe("enrichment rows", () => {
  function record(
    database: Database,
    eventId: string,
    outcome: EnrichmentOutcome,
  ): void {
    recordEnrichment(database, {
      event_id: eventId,
      producer: "summary",
      prompt_version: PROMPT_VERSION,
      model: "fixture-model",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
      input_hash: "a".repeat(64),
      outcome,
      proposal_ids: outcome === "filed" ? ["01ARZ3NDEKTSV4RRFFQ69G5FAP"] : [],
      error_code: outcome === "error" ? "network" : null,
      at: "2026-03-01T00:00:00.000Z",
    });
  }

  test("a non-error row blocks a re-run, an error row does not", () => {
    const database = open();
    initLlm(database);
    record(database, "ev-1", "filed");
    record(database, "ev-2", "error");
    expect([
      ...completedProducers(database, "ev-1", PROMPT_VERSION, "fixture-model"),
    ]).toEqual(["summary"]);
    expect([
      ...completedProducers(database, "ev-2", PROMPT_VERSION, "fixture-model"),
    ]).toEqual([]);
  });

  test("a different model or prompt version is a different key", () => {
    const database = open();
    initLlm(database);
    record(database, "ev-1", "filed");
    expect([
      ...completedProducers(database, "ev-1", PROMPT_VERSION, "other-model"),
    ]).toEqual([]);
    expect([
      ...completedProducers(database, "ev-1", "v2", "fixture-model"),
    ]).toEqual([]);
  });

  test("recording the same key twice replaces the outcome", () => {
    const database = open();
    initLlm(database);
    record(database, "ev-1", "error");
    record(database, "ev-1", "filed");
    expect(
      database.query("SELECT count(*) AS n FROM llm_enrichments").get(),
    ).toEqual({ n: 1 });
    expect([
      ...completedProducers(database, "ev-1", PROMPT_VERSION, "fixture-model"),
    ]).toEqual(["summary"]);
  });

  test("sweeping forgets rows whose event is gone", () => {
    const database = open();
    initLlm(database);
    record(database, "ev-1", "filed");
    record(database, "ev-2", "filed");
    expect(sweepOrphans(database)).toBe(2);
    expect(sweepOrphans(database)).toBe(0);
  });
});
