import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
import { WORLD_JOBS, registerWorldJobs, type WorldJob, type WorldJobContext } from "../../src/serve/world-jobs";
import { initVault } from "../../src/vault/init";

const dirs: string[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-world-jobs-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}

function job(id: string, run: WorldJob["run"]): WorldJob {
  return { id, run };
}

describe("world jobs in the sync pass", () => {
  test("the shipped registry is empty until a workstream registers a job", () => {
    expect(WORLD_JOBS).toEqual([]);
  });

  test("a registered job runs once per pass, in order, after extraction and with the pass context", async () => {
    const { path, db } = vault();
    const seen: string[] = [];
    let context: WorldJobContext | undefined;
    disposers.push(registerWorldJobs([
      job("first", (ctx) => { seen.push("first"); context = ctx; }),
      job("second", async () => { await Promise.resolve(); seen.push("second"); }),
    ]));
    const receipt = await runRail(db, path, "sync");
    expect(seen).toEqual(["first", "second"]);
    expect(receipt.status).toBe("ok");
    expect(context?.db).toBe(db);
    expect(context?.vaultPath).toBe(path);
    expect(context?.modelConfigured).toBe(false);
    expect(context?.now()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await runRail(db, path, "sync");
    expect(seen).toEqual(["first", "second", "first", "second"]);
    db.close();
  });

  test("a failing job degrades the pass with a redacted error and never stops the next job", async () => {
    const { path, db } = vault();
    const seen: string[] = [];
    disposers.push(registerWorldJobs([
      job("broken", () => { throw new Error("synthetic failure"); }),
      job("after", () => { seen.push("after"); }),
    ]));
    const receipt = await runRail(db, path, "sync");
    expect(seen).toEqual(["after"]);
    expect(receipt.status).toBe("degraded");
    expect(receipt.errors).toEqual(["world_job:broken:synthetic failure"]);
    db.close();
  });

  test("a stop request ends the pass before the next job", async () => {
    const { path, db } = vault();
    const seen: string[] = [];
    let stop = false;
    disposers.push(registerWorldJobs([
      job("one", () => { seen.push("one"); stop = true; }),
      job("two", () => { seen.push("two"); }),
    ]));
    const receipt = await runRail(db, path, "sync", { stopRequested: () => stop });
    expect(seen).toEqual(["one"]);
    expect(receipt.status).toBe("stopped");
    expect(receipt.stopped).toBe("serve:stop_requested");
    db.close();
  });

  test("a duplicate job id is refused", () => {
    disposers.push(registerWorldJobs([job("same", () => undefined)]));
    expect(() => registerWorldJobs([job("same", () => undefined)])).toThrow("already registered");
  });
});
