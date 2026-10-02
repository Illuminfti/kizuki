import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { rebuildPageIndex } from "../../src/canon/store";
import type { CaptureEventInput } from "../../src/contracts/event";
import type { ProducerPort } from "../../src/contracts/producer";
import { runBatch } from "../../src/ingest/run";
import { openLedger } from "../../src/ledger/db";
import { runWritePass } from "../../src/serve/write-pass";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";

/**
 * The loop's own sync pass, with a model configured: a source that deleted a
 * record and then has it again gets its canon page back, and a source that
 * deletes it again gets it archived again.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const producer: ProducerPort = {
  descriptor: {
    id: "kizuki.producer.restore-test",
    kind: "producer",
    contract: "kizuki.producer/v1",
    contract_minor: 1,
    supports: ["model"],
    requires_lease: false,
    optional_package: null,
  },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({
    status: "ok",
    claims: [],
    usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
  }),
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-source-restore-"));
  directories.push(root);
  const path = join(root, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  const context = { vault_path: path };
  const grants = { page_candidates: false };
  const ingest = (events: CaptureEventInput[]) => {
    const result = runBatch(
      db,
      { events, cursor: null, has_more: false },
      grants,
      undefined,
      context,
    );
    expect(result.errors).toEqual([]);
    return result;
  };
  const pass = () =>
    runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 16 }),
      model_ref: "kizuki.llm.synthetic:restore-test",
      producer,
      claims: { db },
    });
  const pages = () =>
    db
      .query<{ rel_path: string }, []>(
        "SELECT rel_path FROM page_index WHERE rel_path LIKE 'auto/%' ORDER BY rel_path",
      )
      .all()
      .map((row) => ({
        path: row.rel_path,
        status: parseFrontmatter(readFileSync(join(path, row.rel_path), "utf8"))
          .data["status"],
      }));
  return { db, path, ingest, pass, pages };
}

const live = (epoch = 0): CaptureEventInput => ({
  ...validEvent(),
  metadata:
    epoch === 0 ? { thread: "t-9" } : { thread: "t-9", revision_epoch: epoch },
});
const deleted = (text: string): CaptureEventInput => ({
  ...validEvent(),
  deleted: true,
  text,
});

test("restoration and page-index rebuild retain connector-scoped subject identity", async () => {
  const { db, path, ingest, pass } = fixture();
  try {
    ingest([live()]);
    await pass();
    const keys = () => db.query<{ subject_key: string }, []>(
      "SELECT subject_key FROM page_index WHERE rel_path LIKE 'auto/%' ORDER BY rel_path",
    ).all().map(row => row.subject_key);
    const before = keys();
    expect(before).toEqual(["fixture/person/ada"]);
    rebuildPageIndex({ db, vault_path: path });
    expect(keys()).toEqual(before);
    ingest([deleted("synthetic deletion one")]);
    await pass();
    ingest([live(2)]);
    expect((await pass()).errors).toEqual([]);
    expect(keys()).toEqual(before);
    rebuildPageIndex({ db, vault_path: path });
    expect(keys()).toEqual(before);
  } finally { db.close(); }
});

test("the sync pass brings an archived page back when its source record returns, and archives it again on the next deletion", async () => {
  const { db, ingest, pass, pages } = fixture();
  try {
    ingest([live()]);
    expect((await pass()).errors).toEqual([]);
    expect(pages()).toEqual([
      {
        path: "auto/fixture/person/ada.md",
        status: "active",
      },
    ]);

    ingest([deleted("synthetic deletion one")]);
    expect((await pass()).errors).toEqual([]);
    expect(pages().map((page) => page.status)).toEqual(["archived"]);

    // The source has the record back: a pass with no other work restores it.
    ingest([live(2)]);
    const restored = await pass();
    expect(restored.errors).toEqual([]);
    expect(restored.canon_writes).toBe(1);
    expect(pages().map((page) => page.status)).toEqual(["active"]);
    expect((await pass()).canon_writes).toBe(0);

    ingest([deleted("synthetic deletion two")]);
    expect((await pass()).errors).toEqual([]);
    expect(pages().map((page) => page.status)).toEqual(["archived"]);
  } finally {
    db.close();
  }
});

test("a record still deleted at its source keeps its page archived through every pass", async () => {
  const { db, ingest, pass, pages } = fixture();
  try {
    ingest([live()]);
    await pass();
    ingest([deleted("synthetic deletion one")]);
    await pass();
    for (let round = 0; round < 3; round += 1) {
      expect((await pass()).canon_writes).toBe(0);
      expect(pages().map((page) => page.status)).toEqual(["archived"]);
    }
  } finally {
    db.close();
  }
});

test("a returned source record stays archived until a model is configured", async () => {
  const { db, path, ingest, pass, pages } = fixture();
  try {
    ingest([live()]);
    await pass();
    ingest([deleted("synthetic deletion one")]);
    await pass();
    ingest([live(2)]);
    const result = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 16 }),
    });
    expect(result.errors).toEqual([]);
    expect(result.canon_writes).toBe(0);
    expect(pages().map((page) => page.status)).toEqual(["archived"]);
    expect((await pass()).errors).toEqual([]);
    expect(pages().map((page) => page.status)).toEqual(["active"]);
  } finally { db.close(); }
});

for (const ceiling of ["run", "day"] as const) {
  test(`automatic restoration respects the ${ceiling} canon write budget`, async () => {
    const { db, path, ingest, pass, pages } = fixture();
    try {
      ingest([live()]);
      await pass();
      ingest([deleted("synthetic deletion one")]);
      await pass();
      ingest([live(2)]);
      const result = await runWritePass(db, path, {
        budget: createBudgetTracker({
          canon_writes_per_run: ceiling === "run" ? 0 : 16,
          ...(ceiling === "day" ? { canon_writes_per_day: { limit: 0, used: 0 } } : {}),
        }),
        model_ref: "kizuki.llm.synthetic:restore-test", producer, claims: { db },
      });
      expect(result.errors).toEqual([]);
      expect(result.canon_writes).toBe(0);
      expect(result.stopped).toBe(`budget:canon_writes_per_${ceiling}`);
      expect(pages().map((page) => page.status)).toEqual(["archived"]);
      expect((await pass()).errors).toEqual([]);
      expect(pages().map((page) => page.status)).toEqual(["active"]);
    } finally { db.close(); }
  });
}
