import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Connector,
  Manifest,
  PurgePlan,
  SyncBatch,
} from "../../src/contracts/connector";
import type { CaptureEventInput } from "../../src/contracts/event";
import type { ProducerPort } from "../../src/contracts/producer";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { runToCompletion } from "../../src/ingest/run";
import { fileProposal, initStaging } from "../../src/staging/proposals";
import { loadServeConfig } from "../../src/serve/config";
import { runServeDaemon } from "../../src/serve/daemon";
import { thisProcess } from "../../src/serve/leases";
import {
  runRail,
  type RailRefreshReport,
  type RailSyncDrain,
  type RailSyncResult,
} from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import { DEFAULT_SERVE_CONFIG } from "../../src/serve/types";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";
import { validEvent } from "../fixtures";

// Every pass commits real batches to a real ledger on a shared host.
setDefaultTimeout(120_000);

const SOURCE = "01JJ0000000000000000000003";
const MODEL_REF = "kizuki.llm.openai-compatible:synthetic@local";
const PAGES = 100;

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(serveToml?: string) {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-sync-drain-"));
  dirs.push(directory);
  const vault = join(directory, "vault");
  initVault(vault);
  if (serveToml !== undefined)
    writeFileSync(join(vault, ".kizuki", "serve.toml"), serveToml);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  initStaging(db);
  registerConnection(db, "fixture", SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE,
    expected_revision: 0,
    operation_id: `fixture-${SOURCE}`,
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
  return { vault, db };
}

/**
 * A source of one-event pages. Reading a page takes `pageSeconds` of the
 * test's clock, standing for the round trip a real provider costs.
 */
class PagedConnector implements Connector {
  readonly cursors: (string | null)[] = [];
  constructor(private readonly pageSeconds: () => void = () => undefined) {}
  manifest(): Manifest {
    return {
      schema: "kizuki.connector/v1",
      connector_id: "fixture",
      version: "1.0.0",
      kinds: ["message"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: true,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      auth_modes: ["none"],
    };
  }
  health(): never {
    throw new Error("not used by the ingest runner");
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  revoke(): Promise<void> {
    return Promise.resolve();
  }
  purgeSource(subject_id: string): Promise<PurgePlan> {
    return Promise.resolve({
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    });
  }
  fixture(): Promise<CaptureEventInput[]> {
    return Promise.resolve([]);
  }
  backfill(cursor: string | null): Promise<SyncBatch> {
    return this.sync(cursor);
  }
  async sync(cursor: string | null): Promise<SyncBatch> {
    this.pageSeconds();
    this.cursors.push(cursor);
    const index =
      cursor === null ? 1 : Number(cursor.slice("page-".length)) + 1;
    if (index > PAGES) return { events: [], cursor };
    return {
      events: [
        {
          ...validEvent(),
          source_record_id: `page-${index}`,
          text: `Synthetic page ${index} of a long backfill.`,
        },
      ],
      cursor: `page-${index}`,
      has_more: index < PAGES,
    };
  }
}

/** What a host's sync hook does with the pass budget: drain each connection within its share. */
function drainingHook(
  db: ReturnType<typeof fixture>["db"],
  vault: string,
  connector: Connector,
  seen: RailSyncDrain[],
) {
  return async (drain: RailSyncDrain): Promise<RailSyncResult> => {
    seen.push(drain);
    const result = await runToCompletion(
      db,
      connector,
      "fixture",
      SOURCE,
      "sync",
      {
        vault_path: vault,
        slice: {
          max_batches: drain.max_batches,
          deadline_ms: drain.deadline_ms,
        },
        ...(drain.stopRequested === undefined
          ? {}
          : { stopRequested: drain.stopRequested }),
      },
    );
    return {
      ...(result.has_more === true ? { has_more: true as const } : {}),
      events_synced: result.stored + result.duplicates,
      events_stored: result.stored,
      events_duplicate: result.duplicates,
      events_self_skipped: 0,
      errors: result.errors,
    };
  };
}

describe("[serve] connector drain settings", () => {
  test("default to 120 seconds and 100 batches, and keep them within bounds", () => {
    const { vault } = fixture();
    expect(loadServeConfig(vault)).toMatchObject({
      connector_drain_seconds: 120,
      connector_drain_batches: 100,
    });
    expect(DEFAULT_SERVE_CONFIG).toMatchObject({
      connector_drain_seconds: 120,
      connector_drain_batches: 100,
    });

    writeFileSync(
      join(vault, ".kizuki", "serve.toml"),
      "[serve]\nconnector_drain_seconds = 3600\nconnector_drain_batches = 1\n",
    );
    expect(loadServeConfig(vault)).toMatchObject({
      connector_drain_seconds: 3600,
      connector_drain_batches: 1,
    });

    // Out of range, fractional or mistyped values keep their defaults one by one.
    writeFileSync(
      join(vault, ".kizuki", "serve.toml"),
      "[serve]\nconnector_drain_seconds = 0\nconnector_drain_batches = 10001\n",
    );
    expect(loadServeConfig(vault)).toMatchObject({
      connector_drain_seconds: 120,
      connector_drain_batches: 100,
    });
    writeFileSync(
      join(vault, ".kizuki", "serve.toml"),
      '[serve]\nconnector_drain_seconds = 1.5\nconnector_drain_batches = "10"\n',
    );
    expect(loadServeConfig(vault)).toMatchObject({
      connector_drain_seconds: 120,
      connector_drain_batches: 100,
    });
  });
});

describe("the sync rail drains in bounded passes", () => {
  test("a scripted 100-batch connector takes ten passes of ten batches, each resuming from the cursor", async () => {
    const { vault, db } = fixture(
      "[serve]\nconnector_drain_batches = 10\nconnector_drain_seconds = 90\n",
    );
    try {
      const connector = new PagedConnector();
      const seen: RailSyncDrain[] = [];
      const hooks = { sync: drainingHook(db, vault, connector, seen) };

      const receipts = [];
      for (let pass = 0; pass < 10; pass++)
        receipts.push(await runRail(db, vault, "sync", { hooks }));

      expect(
        seen.map(({ deadline_ms, max_batches }) => [deadline_ms, max_batches]),
      ).toEqual(Array.from({ length: 10 }, () => [90_000, 10]));
      // Nine passes stop with more to read; the tenth finds the source exhausted and says nothing.
      expect(receipts.map((receipt) => receipt.has_more === true)).toEqual([
        ...Array.from({ length: 9 }, () => true),
        false,
      ]);
      expect("has_more" in receipts[9]!).toBe(false);
      expect(receipts.map((receipt) => receipt.events_stored)).toEqual(
        Array.from({ length: 10 }, () => 10),
      );
      // A page is read once: each pass starts at the cursor the last one committed.
      expect(
        connector.cursors.filter((cursor) => cursor === "page-50"),
      ).toHaveLength(1);
      expect(connector.cursors).toHaveLength(100);
      expect(
        listRunReceipts(db, { rail: "sync", limit: 20 }).filter(
          (receipt) => receipt.has_more === true,
        ),
      ).toHaveLength(9);
    } finally {
      db.close();
    }
  });

  test("a pass that stops with more to read still runs the write pass", async () => {
    const { vault, db } = fixture();
    try {
      const events = db.transaction(() =>
        Array.from({ length: 5 }, (_, index) =>
          putEvent(db, {
            source_record_id: `seed-${index}`,
            text: `Seed note ${index}.`,
          }),
        ),
      )();
      for (const [index, event] of events.entries()) {
        const filed = fileProposal(db, {
          kind: "claim",
          target: `notes/seed-${index}`,
          body: `Seed fact ${index}.`,
          frontmatter: { type: "topic", title: `Seed ${index}` },
          provenance: [event],
          subjects: [`topic:seed-${index}`],
          producer: "deterministic",
          confidence: 0.8,
        });
        if (filed.outcome !== "stored")
          throw new Error("expected stored claim");
      }
      const producer: ProducerPort = {
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
        produce: async () => ({
          status: "unavailable",
          reason: "http",
          usage: { calls: 1, input_tokens: 0, output_tokens: 0 },
        }),
      };
      const receipt = await runRail(db, vault, "sync", {
        hooks: {
          sync: async () => ({
            has_more: true,
            events_synced: 1,
            events_stored: 1,
            events_duplicate: 0,
            events_self_skipped: 0,
            errors: [],
          }),
          producer,
          claims: { db },
          model_ref: MODEL_REF,
        },
      });
      expect(receipt).toMatchObject({ has_more: true, canon_writes: 5 });
    } finally {
      db.close();
    }
  });

  test("a stop request between batches ends the pass within one batch and skips the rebuild", async () => {
    const { vault, db } = fixture();
    try {
      let stop = false;
      // The request arrives while the fifth batch is being read.
      const connector = new PagedConnector(() => {
        if (connectorReads() === 4) stop = true;
      });
      const connectorReads = () => connector.cursors.length;
      let refreshed = 0;
      const refresh = async (): Promise<RailRefreshReport> => {
        refreshed += 1;
        return { indexed: 0, remaining: 0, degraded: [] };
      };

      const receipt = await runRail(db, vault, "sync", {
        hooks: { sync: drainingHook(db, vault, connector, []), refresh },
        stopRequested: () => stop,
      });

      expect(connector.cursors).toHaveLength(5);
      expect(receipt).toMatchObject({
        status: "stopped",
        stopped: "serve:stop_requested",
        has_more: true,
        events_stored: 5,
      });
      expect(refreshed).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("other rails keep their schedule during a long backfill", () => {
  test("the daemon's retrieval sweep receipts continue between the sync passes of a 100-batch drain", async () => {
    const { vault, db } = fixture("[serve]\nconnector_drain_batches = 10\nsync_period_s = 60\n");
    try {
      // A pending retrieval operation with no port to retry it makes every sweep a receipted, degraded run.
      db.query(
        `INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at)
         VALUES ('op-1', 'store', 'upsert', 'doc-1', 'pending', ?)`,
      ).run("2026-09-29T00:00:00.000Z");
      // The daemon's clock. Each batch costs 30 seconds of it and each idle turn one second.
      let clock = Date.parse("2026-09-29T00:00:00.000Z");
      const now = () => new Date(clock).toISOString();
      const connector = new PagedConnector(() => { clock += 30_000; });

      await runServeDaemon(db, vault, {
        http: false,
        hooks: { sync: drainingHook(db, vault, connector, []) },
        process: thisProcess(now),
        sleep: async () => { clock += 1_000; },
        shouldContinue: () => connector.cursors.length < PAGES,
      });

      const passes = listRunReceipts(db, { rail: "sync", limit: 50 });
      const sweeps = listRunReceipts(db, { rail: "retrieval-sweep", limit: 100 });
      expect(passes.filter((receipt) => receipt.has_more === true)).toHaveLength(9);
      expect(passes.reduce((total, receipt) => total + receipt.events_stored, 0)).toBe(PAGES);
      // Each pass held the loop for ten batches, five minutes of the daemon's clock. The sweep, due every
      // five minutes, still ran between every two passes; one unbounded drain would have held it for fifty.
      for (const [index, pass] of passes.slice(0, -1).entries()) {
        const next = passes[index + 1]!;
        expect(sweeps.some((sweep) => sweep.started_at >= pass.finished_at && sweep.started_at <= next.started_at)).toBe(true);
      }
    } finally { db.close(); }
  });
});
