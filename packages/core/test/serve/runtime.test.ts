import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runRail, type RailHooks } from "../../src/serve/rails";
import { runServeDaemon, readServePid } from "../../src/serve/daemon";
import { listRunReceipts, recoverRunJournal } from "../../src/serve/receipts";
import { InjectedCrash } from "../../src/serve/types";
import type { Database } from "bun:sqlite";
import { ReferenceRetrievalPort, DIRECT_RETRIEVAL_DESCRIPTOR } from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";

const fixtures: { vault: string; db: Database }[] = [];
function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-rail-runtime-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  const value = { vault, db };
  fixtures.push(value);
  return value;
}
afterEach(() => {
  for (const { vault, db } of fixtures.splice(0)) {
    db.close(); rmSync(vault, { recursive: true, force: true });
  }
});
const synced = (stored = 0) => ({ events_synced: stored, events_stored: stored, events_duplicate: 0, events_self_skipped: 0, errors: [] });

test("each rail acquires fresh hooks and closes them before its receipt is published", async () => {
  const f = fixture();
  const lifetime: string[] = [];
  let generation = 0;
  const acquireRuntime = async () => {
    const current = ++generation;
    lifetime.push(`acquire ${current}`);
    return {
      hooks: { sync: async () => { lifetime.push(`sync ${current}`); return synced(current); } },
      async close() {
        lifetime.push(`close ${current}`);
        expect(listRunReceipts(f.db)).toHaveLength(current - 1);
      },
    };
  };
  for (const count of [1, 2]) {
    const receipt = await runRail(f.db, f.vault, "sync", { acquireRuntime });
    expect(receipt.events_stored).toBe(count);
    expect(receipt.status).toBe("ok");
  }
  expect(lifetime).toEqual(["acquire 1", "sync 1", "close 1", "acquire 2", "sync 2", "close 2"]);
});

test("acquisition failure is receipted without exposing its exception", async () => {
  const f = fixture();
  const receipt = await runRail(f.db, f.vault, "sync", {
    acquireRuntime: async () => { throw new Error("synthetic private key and provider response"); },
  });
  expect(receipt.status).toBe("failed");
  expect(receipt.errors).toEqual(["rail runtime acquisition failed"]);
  expect(listRunReceipts(f.db)).toEqual([receipt]);
  expect(readFileSync(join(f.vault, ".kizuki/run-receipts.jsonl"), "utf8")).not.toContain("synthetic private");
});

test("close failure preserves work counts and produces a failed receipt", async () => {
  const f = fixture(); let closes = 0;
  const receipt = await runRail(f.db, f.vault, "sync", {
    acquireRuntime: async () => ({ hooks: { sync: async () => synced(3) },
      close: async () => { closes++; throw new Error("synthetic private shutdown data"); } }),
  });
  expect(closes).toBe(1);
  expect(receipt.status).toBe("failed");
  expect(receipt.events_stored).toBe(3);
  expect(receipt.errors).toEqual(["rail runtime close failed"]);
});

test("hook failures and receipt interruptions each release exactly one acquired runtime", async () => {
  const f = fixture();
  for (const failure of ["hook", "interrupt", "persistence"] as const) {
    let closes = 0;
    const attempt = runRail(f.db, f.vault, "sync", {
      ...(failure === "persistence" ? { crashAfter: "after-jsonl" as const } : {}),
      acquireRuntime: async () => ({ hooks: { sync: async () => {
        if (failure === "hook") throw new Error("sync unavailable");
        if (failure === "interrupt") throw new InjectedCrash("after-jsonl");
        return synced();
      } }, close: async () => { closes++; } }),
    });
    if (failure === "hook") expect((await attempt).status).toBe("failed");
    else await expect(attempt).rejects.toBeInstanceOf(InjectedCrash);
    expect(closes).toBe(1);
    if (failure === "persistence") expect(recoverRunJournal(f.db, f.vault)).toHaveLength(1);
  }
});

test("a close failure during interruption remains visible without exposing cleanup details", async () => {
  const f = fixture(); let closes = 0;
  await expect(runRail(f.db, f.vault, "sync", {
    acquireRuntime: async () => ({ hooks: { sync: async () => { throw new InjectedCrash("after-jsonl"); } },
      close: async () => { closes++; throw new Error("synthetic private cleanup data"); } }),
  })).rejects.toThrow("rail runtime close failed after interruption");
  expect(closes).toBe(1);
});

test("static hooks retain behavior and conflict with runtime acquisition before either is invoked", async () => {
  const f = fixture(); let syncs = 0, acquisitions = 0;
  const hooks: RailHooks = { sync: async () => { syncs++; return synced(7); } };
  expect((await runRail(f.db, f.vault, "sync", { hooks })).events_stored).toBe(7);
  const acquireRuntime = async () => { acquisitions++; return { hooks, close: async () => {} }; };
  const conflict = await runRail(f.db, f.vault, "sync", { hooks, acquireRuntime });
  expect(conflict.status).toBe("failed");
  expect(conflict.errors).toEqual(["rail hooks and acquireRuntime are mutually exclusive"]);
  await expect(runServeDaemon(f.db, f.vault, { once: true, http: false, hooks, acquireRuntime })).rejects.toThrow("mutually exclusive");
  expect(syncs).toBe(1); expect(acquisitions).toBe(0);
  expect(readServePid(f.vault)).toBeNull();
  expect(f.db.query("SELECT * FROM leases").all()).toHaveLength(0);
});

test("sync preflight refuses legacy extraction before acquiring any runtime", async () => {
  const f = fixture(); let acquired = 0;
  f.db.query("INSERT INTO extract_batches(previous_cursor,cursor,drafts,model_ref,created_at) VALUES ('', ?, '[]', 'fixture:model', '2026-09-01')")
    .run("2026-09-01T00:00:00Z\t01K2Z7ZQZK0R4E0RZ5C8QJ7X01");
  const receipt = await runRail(f.db, f.vault, "sync", {
    acquireRuntime: async () => { acquired++; return { hooks: {}, close: async () => {} }; },
  });
  expect(receipt.status).toBe("failed");
  expect(acquired).toBe(0);
  expect(f.db.query("SELECT * FROM extract_batches").all()).toHaveLength(1);
});

for (const once of [false, true]) test(`daemon acquires and closes every rail without replacing its lease, once=${once}`, async () => {
  const f = fixture(); let acquired = 0, closed = 0;
  f.db.query("UPDATE schedules SET enabled=0 WHERE rail <> 'sync'").run();
  const holders: string[] = [];
  const result = await runServeDaemon(f.db, f.vault, {
    once, http: false, ...(once ? { rails: ["sync" as const, "sync" as const] } : {}),
    shouldContinue: () => {
      f.db.query("UPDATE schedules SET next_run_at=NULL WHERE rail='sync'").run();
      return closed < 2;
    },
    acquireRuntime: async () => {
      const count = ++acquired;
      holders.push(readFileSync(join(f.vault, ".kizuki/serve.pid"), "utf8"));
      expect(f.db.query("SELECT * FROM leases").all()).toHaveLength(1);
      return { hooks: { sync: async () => synced(count) }, close: async () => { closed++; } };
    },
  });
  expect(acquired).toBe(2); expect(closed).toBe(2); expect(result.receipts).toBe(2);
  expect(new Set(holders).size).toBe(1);
  expect(listRunReceipts(f.db).map(receipt => receipt.events_stored)).toEqual([1, 2]);
  expect(readServePid(f.vault)).toBeNull();
  expect(f.db.query("SELECT * FROM leases").all()).toHaveLength(0);
});

for (const factory of [false, true]) test(`HTTP keeps its retrieval port and token across rail lifetimes, factory=${factory}`, async () => {
  const f = fixture();
  const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
  const retrieval = new ReferenceRetrievalPort(temporary.ctx);
  const original = retrieval.search.bind(retrieval);
  let searches = 0, closes = 0;
  retrieval.search = async query => { searches++; return original(query); };
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port!; await reserve.stop(true);
  const tokens: string[] = [];
  const hooks: RailHooks = { claims: { db: f.db, retrieval }, sync: async () => {
    const token = readFileSync(join(f.vault, ".kizuki/serve.token"), "utf8").trim(); tokens.push(token);
    const response = await fetch(`http://127.0.0.1:${port}/v1/search`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "synthetic", scope: "all" }) });
    expect(response.status).toBe(200); expect((await response.json() as { ok: boolean }).ok).toBe(true);
    return synced();
  } };
  try {
    await runServeDaemon(f.db, f.vault, { once: true, rails: ["sync", "sync"], port,
      ...(factory ? { retrieval, acquireRuntime: async () => ({ hooks: { sync: hooks.sync! }, close: async () => { closes++; } }) } : { hooks }) });
    expect(searches).toBe(2); expect(tokens).toHaveLength(2); expect(new Set(tokens).size).toBe(1);
    expect(closes).toBe(factory ? 2 : 0);
    expect((await retrieval.health()).status).toBe("ready");
    expect(readServePid(f.vault)).toBeNull();
    expect(f.db.query("SELECT * FROM leases").all()).toHaveLength(0);
  } finally { await retrieval.close(); temporary.cleanup(); }
});

test("SIGTERM lets the active runtime close before releasing the lease and skips the next rail", async () => {
  const f = fixture();
  const base = new URL("../../src/", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--eval", `
    const {openLedger}=await import(${JSON.stringify(base + "ledger/db.ts")});
    const {runServeDaemon}=await import(${JSON.stringify(base + "serve/daemon.ts")});
    const db=openLedger(${JSON.stringify(join(f.vault, ".kizuki/kizuki.db"))});
    await runServeDaemon(db,${JSON.stringify(f.vault)},{once:true,http:false,rails:["sync","brief"],
      acquireRuntime:async()=>({hooks:{sync:async()=>{console.log("entered");await Bun.stdin.text();return ${JSON.stringify(synced())};}},close:async()=>console.log("closed")})});
    db.close();
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("entered");
    child.kill("SIGTERM");
    await Bun.sleep(30); child.stdin.end();
    const remainingOutput = async () => {
      let output = "";
      for (;;) {
        const next = await reader.read(); if (next.done) return output;
        output += new TextDecoder().decode(next.value);
      }
    };
    const [exit, rest, stderr] = await Promise.all([child.exited, remainingOutput(), new Response(child.stderr).text()]);
    expect(exit).toBe(0); expect(stderr).toBe(""); expect(rest.trim()).toBe("closed");
    expect(listRunReceipts(f.db).map(receipt => receipt.rail)).toEqual(["sync"]);
    expect(readServePid(f.vault)).toBeNull();
    expect(f.db.query("SELECT * FROM leases").all()).toHaveLength(0);
  } finally { reader.releaseLock(); child.kill(); await child.exited; }
}, 15_000);
