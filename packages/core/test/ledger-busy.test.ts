import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLedgerBusy, runImmediate } from "../src/ledger/busy";
import { openLedger } from "../src/ledger/db";
import { count } from "../src/ledger/ledger";
import { LEDGER_BUSY_TIMEOUT_MS } from "../src/ledger/limits";
import { runBatch } from "../src/ingest/run";
import { initStaging } from "../src/staging/proposals";
import { asLeaseHeld, LedgerLeaseHeldError } from "../src/serve/lease-held";
import { SERVE_PID_PATH } from "../src/serve/types";
import { validEvent } from "./fixtures";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

interface Holder {
  release(): Promise<void>;
}

/**
 * A second process holding the SQLite write lock, exactly as a serve rail
 * batch does. Resolves once the lock is actually taken.
 */
async function holdWriteLock(path: string, holdMs: number): Promise<Holder> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "ledger-busy-child.ts"),
      path,
      String(holdMs),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("write-lock holder ended before it held");
    buffered += new TextDecoder().decode(chunk.value);
  }
  expect(buffered.split("\n")[0]).toBe("held");
  reader.releaseLock();
  return {
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
    },
  };
}

describe("a busy ledger", () => {
  test("opening waits for a writer that holds the lock past the busy timeout", async () => {
    const directory = temporary("kizuki-busy-open-");
    const path = join(directory, "ledger.sqlite");
    openLedger(path).close();
    const holder = await holdWriteLock(path, 1_200);
    try {
      // Opening runs schema repair inside an immediate transaction. Before the
      // bounded wait this raised the raw `database is locked`.
      const db = openLedger(path);
      try {
        expect(count(db)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await holder.release();
    }
  }, 20_000);

  test("a read returns while another connection holds a write transaction", async () => {
    const directory = temporary("kizuki-busy-read-");
    const path = join(directory, "ledger.sqlite");
    const reader = openLedger(path);
    try {
      const holder = await holdWriteLock(path, 1_000);
      try {
        const started = Date.now();
        expect(count(reader)).toBe(0);
        expect(Date.now() - started).toBeLessThan(LEDGER_BUSY_TIMEOUT_MS);
      } finally {
        await holder.release();
      }
    } finally {
      reader.close();
    }
  }, 20_000);

  test("an import batch completes across a writer that outlives one busy wait", async () => {
    const directory = temporary("kizuki-busy-import-");
    const path = join(directory, "ledger.sqlite");
    const db = openLedger(path);
    initStaging(db);
    try {
      const holder = await holdWriteLock(path, 1_200);
      try {
        const events = Array.from({ length: 3 }, (_, index) => ({
          ...validEvent(),
          source_record_id: `rec-${index}`,
        }));
        const result = runBatch(
          db,
          { events, cursor: "page-2" },
          { page_candidates: false },
        );
        expect(result.errors).toEqual([]);
        expect(result.stored).toBe(3);
      } finally {
        await holder.release();
      }
    } finally {
      db.close();
    }
  }, 20_000);

  test("a writer past every retry raises a typed lease refusal, never SQLITE_BUSY", async () => {
    const vault = temporary("kizuki-busy-lease-");
    mkdirSync(join(vault, ".kizuki"), { recursive: true, mode: 0o700 });
    const path = join(vault, ".kizuki", "kizuki.db");
    openLedger(path).close();
    writeFileSync(
      join(vault, SERVE_PID_PATH),
      `${JSON.stringify({ pid: process.pid, boot_id: "boot-fixture", instance_id: "instance-fixture" })}\n`,
      { mode: 0o600 },
    );
    const db = openLedger(path);
    try {
      const holder = await holdWriteLock(path, 30_000);
      try {
        let raised: unknown;
        try {
          runImmediate(
            db,
            () => db.exec("UPDATE schema_version SET version = version"),
            2,
          );
        } catch (error) {
          raised = error;
        }
        expect(isLedgerBusy(raised)).toBe(true);
        const refusal = asLeaseHeld(vault, raised);
        expect(refusal).toBeInstanceOf(LedgerLeaseHeldError);
        expect(refusal?.code).toBe("lease_held");
        expect(refusal?.message).toContain(
          `the kizuki serve daemon (pid ${process.pid})`,
        );
        expect(refusal?.message).toContain("resumes from the last checkpoint");
        expect(refusal?.message).not.toContain("database is locked");
      } finally {
        await holder.release();
      }
    } finally {
      db.close();
    }
  }, 40_000);
});
