import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import {
  mineLiveDrafts,
  readExtractCursor,
} from "../../src/serve/extract";
import { shouldAdvanceExtractCursor } from "../../src/serve/tri-state";
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
    expect(readExtractCursor(db)).not.toBeNull();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
