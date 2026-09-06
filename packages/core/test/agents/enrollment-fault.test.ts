import { credentialCustodyQualified as qualified } from "./custody-fixture";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authenticateAgentCredential, enrollAgent, revokeAgentEnrollment } from "../../src/agents/enrollment";
import { addAgent, authenticate } from "../../src/agents/identity";
import { openLedger } from "../../src/ledger/db";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-enrollment-fault-")); roots.push(root);
  const vault = join(root, "vault"), control = join(vault, ".kizuki"); mkdirSync(control, { recursive: true, mode: 0o700 });
  const dbPath = join(control, "kizuki.db"), db = openLedger(dbPath); db.close(); chmodSync(dbPath, 0o600);
  const credentialDir = join(control, "agent-credentials"); mkdirSync(credentialDir, { mode: 0o700 });
  const credential = join(credentialDir, "agent.credential");
  const request = { operation_id: "fault-agent-0001", name: "fault-agent", token_ref: `file:${credential}`,
    grant: { ceiling: "public" as const, types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false } };
  return { root, vault, dbPath, credential, request };
}
function childScript(f: ReturnType<typeof fixture>, mode: string): string {
  return `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import { dirname } from "node:path";
    import { Database } from "bun:sqlite";
    import { strict as assert } from "node:assert";
    const mode = ${JSON.stringify(mode)}, vault = ${JSON.stringify(f.vault)}, credential = ${JSON.stringify(f.credential)}, request = ${JSON.stringify(f.request)};
    const realWrite = fs.writeSync, realSync = fs.fsyncSync, realClose = fs.closeSync;
    let fired = false, credentialSynced = false, activeDatabase, mutated = false;
    const ready = ${JSON.stringify(join(f.root, "ready-"))} + process.pid, release = ${JSON.stringify(join(f.root, "release"))};
    function pause() {
      fs.writeFileSync(ready, "ready", { mode: 0o600 });
      const deadline = Date.now() + 10000, wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) {
        assert.ok(Date.now() < deadline, "parent must release the reached barrier");
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    function same(fd, path) {
      if (!fs.existsSync(path)) return false;
      const a = fs.fstatSync(fd, { bigint: true }), b = fs.lstatSync(path, { bigint: true });
      return a.dev === b.dev && a.ino === b.ino;
    }
    function crash() { realWrite(1, "fault reached\\n"); process.kill(process.pid, "SIGKILL"); }
    mock.module("node:fs", () => ({ ...fs,
      closeSync(fd) {
        const change = mode === "cleanup-change" && fired && !mutated && same(fd, credential) && fs.fstatSync(fd).size > 0;
        realClose(fd);
        if (change) { mutated = true; fs.writeFileSync(credential, "changed-after-inspection", { mode: 0o600 }); }
      },
      writeSync(fd, ...args) {
        if (same(fd, credential) && !fired) {
          if (mode === "crash-bound") { fired = true; crash(); }
          if (mode === "crash-partial") { fired = true; realWrite(fd, args[0], args[1], 7, args[3]); crash(); }
        }
        return realWrite(fd, ...args);
      },
      fsyncSync(fd) {
        if (same(fd, credential) && fs.fstatSync(fd).size > 0) {
          if (mode === "fail-file-sync" && !fired) { fired = true; throw new Error("injected sync failure"); }
          realSync(fd); credentialSynced = true; return;
        }
        if (credentialSynced && same(fd, dirname(credential)) && !fired) {
          if (mode === "fail-directory-sync") { fired = true; throw new Error("injected directory sync failure"); }
          if (mode === "crash-durable") { fired = true; realSync(fd); crash(); }
          if (mode === "pause-durable") { fired = true; realSync(fd);
            assert.equal(authenticateAgentCredential(activeDatabase, ${JSON.stringify(`file:${f.dbPath}`)}), null);
            pause(); return; }
        }
        return realSync(fd);
      },
    }));
    const originalTransaction = Database.prototype.transaction, originalPrepare = Database.prototype.prepare, originalClose = Database.prototype.close;
    let faultDatabase, oldClosed = false, readNewConnection = false;
    Database.prototype.close = function(...args) {
      const output = originalClose.apply(this, args);
      if (this === faultDatabase) oldClosed = true;
      return output;
    };
    Database.prototype.prepare = function(...args) {
      if (faultDatabase && fired) {
        assert.notEqual(this, faultDatabase, "uncertain connection was queried again");
        assert.equal(oldClosed, true, "old connection must close before reconciliation"); readNewConnection = true;
      }
      const statement = originalPrepare.apply(this, args);
      if (mode === "cleanup-race" && fired && args[0].startsWith("SELECT * FROM agent_enrollments WHERE operation_id")) {
        const get = statement.get.bind(statement);
        statement.get = (...values) => {
          const row = get(...values);
          if (row?.state === "file_bound" && !fs.existsSync(ready)) pause();
          return row;
        };
      }
      return statement;
    };
    function phase(db) {
      using exists = originalPrepare.call(db, "SELECT name FROM sqlite_master WHERE name='agent_enrollments'");
      if (!exists.get()) return null;
      using state = originalPrepare.call(db, "SELECT state FROM agent_enrollments WHERE operation_id=?");
      return state.get(request.operation_id)?.state;
    }
    Database.prototype.transaction = function(callback) {
      const db = this;
      const transaction = originalTransaction.call(db, function(...args) {
        activeDatabase = db;
        const output = callback(...args);
        if ((mode === "commit-before" || mode === "cleanup-race" || mode === "cleanup-change" || mode === "bind-commit-before") && !fired && phase(db) === (mode === "bind-commit-before" ? "file_bound" : "completed")) {
          fired = true; faultDatabase = db; throw new Error("injected before commit");
        }
        return output;
      });
      const wrap = method => (...args) => {
        const output = transaction[method](...args);
        if (mode === "pause-bound" && !fired && phase(db) === "file_bound") { fired = true; pause(); }
        const wanted = mode === "reserve-commit-after" ? "reserved" : mode === "bind-commit-after" ? "file_bound" : "completed";
        if (mode.endsWith("commit-after") && !fired && phase(db) === wanted) {
          fired = true; faultDatabase = db; throw new Error("injected lost commit response");
        }
        return output;
      };
      return Object.assign((...args) => transaction(...args), { immediate: wrap("immediate"), exclusive: wrap("exclusive"), deferred: wrap("deferred") });
    };
    const { enrollAgent, authenticateAgentCredential } = await import(${JSON.stringify(join(import.meta.dir, "../../src/agents/enrollment.ts"))});
    if (mode === "start-barrier") { fired = true; pause(); }
    const result = enrollAgent(vault, request);
    assert.equal(fired, true, "fault or barrier must actually be reached");
    if (mode === "cleanup-change") assert.equal(mutated, true, "late byte mutation must actually be reached");
    if (mode.includes("commit")) assert.equal(readNewConnection, true, "commit outcome must be read through a new connection");
    process.stdout.write(JSON.stringify(result) + "\\n");
  `;
}

test.if(qualified)("rollback cleanup retains a file changed after the separate Core inspection", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, "--eval", childScript(f, "cleanup-change")], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(child.exitCode).toBe(0); expect(child.stderr.length).toBe(0);
  expect(existsSync(f.credential)).toBe(true);
  expect(readFileSync(f.credential).equals(Buffer.from("changed-after-inspection"))).toBe(true);
  expect(JSON.parse(child.stdout.toString())).toMatchObject({ status: "pending", authority: "none", credential: "incomplete" });
  const db = openLedger(f.dbPath);
  expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM agent_audit WHERE tool='agent.create'").get()).toEqual({ n: 0 });
  expect(authenticateAgentCredential(db, f.request.token_ref)).toBeNull(); db.close();
});

test.if(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.arch === "x64")("crash and commit proof requires qualified Linux custody", () => {
  expect(qualified).toBe(true);
});

for (const mode of ["crash-bound", "crash-partial", "crash-durable"] as const) {
  test.if(qualified)(`real process ${mode} leaves no active authority and recovers only complete bytes`, () => {
    const f = fixture();
    const child = Bun.spawnSync([process.execPath, "--eval", childScript(f, mode)], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(child.exitCode).not.toBe(0); expect(child.stdout.toString().trim()).toBe("fault reached");
    expect(child.stderr.length).toBe(0);
    const db = openLedger(f.dbPath);
    expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 });
    expect(authenticateAgentCredential(db, f.request.token_ref)).toBeNull();
    expect(db.query("SELECT state FROM agent_enrollments").get()).toEqual({ state: "file_bound" }); db.close();
    const before = readFileSync(f.credential), retried = enrollAgent(f.vault, f.request);
    expect(readFileSync(f.credential).equals(before), "restart never rewrites a retained file").toBe(true);
    if (mode === "crash-durable") {
      expect(retried).toMatchObject({ status: "completed", authority: "active", credential: "ready", replayed: true });
      const reopened = openLedger(f.dbPath); expect(authenticateAgentCredential(reopened, f.request.token_ref)?.kind).toBe("agent"); reopened.close();
    } else expect(retried).toMatchObject({ status: "pending", authority: "none", credential: "incomplete" });
  });
}

for (const mode of ["fail-file-sync", "fail-directory-sync", "commit-before", "reserve-commit-after", "bind-commit-after", "commit-after"] as const) {
  test.if(qualified)(`${mode} reconciles authority without printing or duplicating credentials`, () => {
    const f = fixture();
    const child = Bun.spawnSync([process.execPath, "--eval", childScript(f, mode)], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(child.exitCode, "fault child completed its assertions").toBe(0);
    expect(child.stderr.length).toBe(0);
    const response = JSON.parse(child.stdout.toString());
    const successfulCommit = mode.endsWith("commit-after");
    expect(response.status).toBe(successfulCommit ? "completed" : "pending");
    expect(response.authority).toBe(successfulCommit ? "active" : "none");
    const db = openLedger(f.dbPath);
    expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: successfulCommit ? 1 : 0 });
    expect(db.query("SELECT count(*) AS n FROM agent_audit WHERE tool='agent.create'").get()).toEqual({ n: successfulCommit ? 1 : 0 }); db.close();
    if (existsSync(f.credential)) {
      const token = (JSON.parse(readFileSync(f.credential, "utf8")) as { token: string }).token;
      expect(child.stdout.toString().includes(token), "stdout never contains the credential").toBe(false);
    }
    const retry = enrollAgent(f.vault, f.request);
    expect(retry).toMatchObject({ status: "completed", authority: "active", credential: "ready", replayed: true });
    const final = openLedger(f.dbPath);
    expect(final.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 1 });
    expect(final.query("SELECT count(*) AS n FROM agent_audit WHERE tool='agent.create'").get()).toEqual({ n: 1 }); final.close();
  });
}

async function paused(f: ReturnType<typeof fixture>, mode: string) {
  const child = Bun.spawn([process.execPath, "--eval", childScript(f, mode)], { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 12_000;
    while (!existsSync(join(f.root, `ready-${child.pid}`))) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error("child did not reach the required barrier");
      await Bun.sleep(10);
    }
  } catch (error) {
    child.kill(); await child.exited;
    // These child scripts use synthetic requests and never emit token bytes.
    expect(await stderr, "barrier child diagnostics").toBe("");
    throw error;
  }
  return {
    async finish() {
      writeFileSync(join(f.root, "release"), "release", { mode: 0o600 });
      expect(await child.exited).toBe(0); expect(await stderr).toBe("");
      return JSON.parse(await stdout);
    },
    async stop() { if (child.exitCode === null) child.kill(); await child.exited; },
  };
}

test.if(qualified)("cancel between binding and activation defeats the retained writer and name reuse", async () => {
  const f = fixture(), child = await paused(f, "pause-bound");
  try {
    expect(readFileSync(f.credential).length).toBe(0);
    expect(revokeAgentEnrollment(f.vault, f.request.name)).toMatchObject({ status: "cancelled", authority: "none", credential: "unknown" });
    const db = openLedger(f.dbPath), replacement = addAgent(db, f.request.name); db.close();
    expect(await child.finish()).toMatchObject({ status: "cancelled", authority: "none" });
    expect(readFileSync(f.credential).length).toBe(0);
    const reopened = openLedger(f.dbPath);
    expect(authenticate(reopened, replacement.token)?.kind).toBe("agent");
    expect(reopened.query("SELECT count(*) AS n FROM agent_audit WHERE tool='agent.create'").get()).toEqual({ n: 1 }); reopened.close();
    expect(revokeAgentEnrollment(f.vault, f.request.name)).toMatchObject({ agent_id: replacement.agent.agent_id, operation_id: null, authority: "revoked" });
  } finally { await child.stop(); }
}, 20_000);

test.if(qualified)("activation holds the SQLite writer mutex across durable file verification", async () => {
  const f = fixture(), child = await paused(f, "pause-durable");
  try {
    // An already open reader sees no identity, even with a complete durable file.
    const { Database } = await import("bun:sqlite");
    const db = new Database(f.dbPath);
    try {
      expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 });
      expect(authenticateAgentCredential(db, f.request.token_ref)).toBeNull();
      expect(() => db.transaction(() => {}).immediate()).toThrow(/locked|busy/);
    } finally { db.close(); }
    expect(await child.finish()).toMatchObject({ status: "completed", authority: "active", credential: "ready" });
    expect(revokeAgentEnrollment(f.vault, f.request.name)).toMatchObject({ status: "completed", authority: "revoked" });
  } finally { await child.stop(); }
}, 20_000);

test.if(qualified)("late rollback cleanup preserves a credential completed by another process", async () => {
  const f = fixture(), child = await paused(f, "cleanup-race");
  try {
    const before = readFileSync(f.credential);
    expect(enrollAgent(f.vault, f.request)).toMatchObject({ status: "completed", credential: "ready" });
    expect(await child.finish()).toMatchObject({ status: "completed", credential: "ready" });
    expect(readFileSync(f.credential).equals(before)).toBe(true);
    const db = openLedger(f.dbPath);
    expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM agent_audit WHERE tool='agent.create'").get()).toEqual({ n: 1 }); db.close();
  } finally { await child.stop(); }
}, 20_000);

test.if(qualified)("a lost complete-file recovery COMMIT response reopens before classifying success", () => {
  const f = fixture();
  const crash = Bun.spawnSync([process.execPath, "--eval", childScript(f, "crash-durable")], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(crash.stdout.toString().trim()).toBe("fault reached"); expect(crash.exitCode).not.toBe(0);
  const before = readFileSync(f.credential);
  const recovery = Bun.spawnSync([process.execPath, "--eval", childScript(f, "commit-after")], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(recovery.exitCode).toBe(0); expect(recovery.stderr.length).toBe(0);
  expect(JSON.parse(recovery.stdout.toString())).toMatchObject({ status: "completed", credential: "ready" });
  expect(readFileSync(f.credential).equals(before)).toBe(true);
});

test.if(qualified)("binding rollback retains an inert unbound empty file and refuses adoption", () => {
  const f = fixture();
  const child = Bun.spawnSync([process.execPath, "--eval", childScript(f, "bind-commit-before")], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(child.exitCode).toBe(0); expect(child.stderr.length).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toMatchObject({ status: "pending", authority: "none", credential: "conflict" });
  expect(readFileSync(f.credential).length).toBe(0);
  expect(enrollAgent(f.vault, f.request)).toMatchObject({ status: "pending", authority: "none", credential: "conflict" });
  const db = openLedger(f.dbPath);
  expect(db.query("SELECT state FROM agent_enrollments").get()).toEqual({ state: "reserved" });
  expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 }); db.close();
});

test.if(qualified)("simultaneous same-operation processes converge on one identity and create audit", async () => {
  const f = fixture();
  const children = await Promise.all(Array.from({ length: 3 }, () => paused(f, "start-barrier")));
  try {
    const results = await Promise.all(children.map(child => child.finish()));
    expect(results.every(row => row.status === "completed" || row.status === "pending")).toBe(true);
    const final = enrollAgent(f.vault, f.request);
    expect(final).toMatchObject({ status: "completed", credential: "ready" });
    expect(results.every(row => row.agent_id === final.agent_id)).toBe(true);
    const db = openLedger(f.dbPath);
    expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM agent_audit WHERE tool='agent.create'").get()).toEqual({ n: 1 }); db.close();
  } finally { await Promise.all(children.map(child => child.stop())); }
}, 20_000);
