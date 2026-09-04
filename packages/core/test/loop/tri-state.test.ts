import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import {
  commitExtractCursor,
  mineLiveDrafts,
  readExtractCursor,
  shouldAdvanceExtractCursor,
} from "../../src/serve/extract";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

function stubProducer(result: ProduceResult): ProducerPort {
  return {
    descriptor: {
      id: "kizuki.producer.fixture",
      kind: "producer",
      contract: "kizuki.producer/v1",
      contract_minor: 1,
      supports: ["model"],
      requires_lease: false,
      optional_package: null,
    },
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    produce: async () => result,
  };
}

describe("extract tri-state cursor", () => {
  test("unavailable is not empty", () => {
    expect(shouldAdvanceExtractCursor({ status: "ok", count: 1 })).toBe(true);
    expect(shouldAdvanceExtractCursor({ status: "empty" })).toBe(true);
    expect(
      shouldAdvanceExtractCursor({ status: "unavailable", reason: "no model" }),
    ).toBe(false);
    expect(
      shouldAdvanceExtractCursor({ status: "rejected", reason: "schema_invalid" }),
    ).toBe(false);
  });

  test("model unavailable does not advance the checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-tri-state-"));
    const path = join(directory, "vault");
    initVault(path);
    const db = openLedger(join(path, ".kizuki", "kizuki.db"));
    putEvent(db, { source_record_id: "one" });
    expect(readExtractCursor(db)).toBeNull();
    const mined = await mineLiveDrafts(
      db,
      stubProducer({ status: "unavailable", reason: "llm unavailable" }),
    );
    expect(mined.mined.status).toBe("unavailable");
    expect(readExtractCursor(db)).toBeNull();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("model returning no claims advances the checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-tri-state-"));
    const path = join(directory, "vault");
    initVault(path);
    const db = openLedger(join(path, ".kizuki", "kizuki.db"));
    putEvent(db, { source_record_id: "one" });
    const mined = await mineLiveDrafts(
      db,
      stubProducer({
        status: "ok",
        claims: [],
        usage: { calls: 1, input_tokens: 10, output_tokens: 4 },
      }),
    );
    expect(mined.mined.status).toBe("empty");
    expect(commitExtractCursor(db, mined)).toBe(true);
    expect(readExtractCursor(db)).not.toBeNull();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("model unavailable is counted separately from an empty result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-tri-state-"));
    const path = join(directory, "vault");
    initVault(path);
    const db = openLedger(join(path, ".kizuki", "kizuki.db"));
    putEvent(db, { source_record_id: "one" });
    const unavailable = await mineLiveDrafts(
      db,
      stubProducer({ status: "unavailable", reason: "llm unavailable" }),
    );
    const empty = await mineLiveDrafts(
      db,
      stubProducer({
        status: "ok",
        claims: [],
        usage: { calls: 1, input_tokens: 8, output_tokens: 2 },
      }),
    );
    expect(unavailable.mined.status).toBe("unavailable");
    expect(empty.mined.status).toBe("empty");
    expect(unavailable.mined).not.toEqual(empty.mined);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a packet-marked event is skipped and advances the cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-tri-state-"));
    const path = join(directory, "vault");
    initVault(path);
    const db = openLedger(join(path, ".kizuki", "kizuki.db"));
    putEvent(db, {
      source_record_id: "packet",
      text: "KIZUKI CONTEXT v1\nprincipal=owner purpose=session",
    });
    let called = 0;
    const producer = stubProducer({
      status: "ok",
      claims: [],
      usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    const wrapped: ProducerPort = {
      ...producer,
      produce: async (input) => {
        called += 1;
        return producer.produce(input);
      },
    };
    const mined = await mineLiveDrafts(db, wrapped);
    expect(mined.mined.status).toBe("empty");
    expect(called).toBe(0);
    expect(commitExtractCursor(db, mined)).toBe(true);
    expect(readExtractCursor(db)).not.toBeNull();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("deleted and context packets never reach the model input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-tri-state-"));
    const path = join(directory, "vault");
    initVault(path);
    const db = openLedger(join(path, ".kizuki", "kizuki.db"));
    const deleted = putEvent(db, { source_record_id: "deleted", text: "deleted source" });
    db.query("UPDATE events SET deleted = 1 WHERE event_id = ?").run(deleted);
    putEvent(db, { source_record_id: "context", text: "KIZUKI CONTEXT v1\nprincipal=owner" });
    putEvent(db, { source_record_id: "live", text: "live source" });
    let seen = [] as readonly string[];
    const producer = stubProducer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } });
    const mined = await mineLiveDrafts(db, {
      ...producer,
      produce: async (input) => {
        seen = input.events.map((event) => event.text);
        return producer.produce(input);
      },
    });
    expect(mined.mined.status).toBe("empty");
    expect(seen).toEqual(["live source"]);
    expect(commitExtractCursor(db, mined)).toBe(true);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a stale extraction result cannot overwrite a newer checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-tri-state-"));
    const path = join(directory, "vault");
    initVault(path);
    const db = openLedger(join(path, ".kizuki", "kizuki.db"));
    putEvent(db, { source_record_id: "one" });
    const mined = await mineLiveDrafts(
      db,
      stubProducer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
    );
    expect(mined.cursor).not.toBeNull();
    const newer = "2026-09-05T00:00:00.000Z\t01JNEWERCURSOR00000000000000";
    const { writeCheckpoint } = await import("../../src/ledger/checkpoints");
    writeCheckpoint(db, "kizuki.producer.model", "extract", newer);
    expect(commitExtractCursor(db, mined)).toBe(false);
    expect(readExtractCursor(db)).toBe(newer);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
