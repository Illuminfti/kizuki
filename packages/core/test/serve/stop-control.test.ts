import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { withVaultMutationSync } from "../../src/vault/mutation-scope";
import { readServeProcessMarker, runServeDaemon, type ServeProcessMarker } from "../../src/serve/daemon";
import { readBootId, readLease } from "../../src/serve/leases";
import { listRunReceipts } from "../../src/serve/receipts";
import { clearServeStopRequest, requestServeStop, serveStopRequested } from "../../src/serve/stop-control";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-stop-control-")); roots.push(root); initVault(root);
  const own = { pid: process.pid, boot_id: readBootId(), instance_id: crypto.randomUUID() };
  const marker = join(root, ".kizuki/serve.pid"), request = join(root, ".kizuki/serve-stop.json"), stage = join(root, ".kizuki/.serve-stop.tmp");
  writeFileSync(marker, JSON.stringify(own), { mode: 0o600 });
  return { root, own, marker, request, stage };
}
const bytes = (own: ServeProcessMarker) => JSON.stringify({ schema: "kizuki.serve-stop/v1", ...own });

test("concurrent requests converge on one private immutable publication", async () => {
  const f = fixture();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => requestServeStop(f.root)));
  expect(outcomes.filter(x => x.status === "queued")).toHaveLength(1);
  expect(outcomes.every(x => x.instance_id === f.own.instance_id)).toBe(true);
  const before = lstatSync(f.request), data = readFileSync(f.request);
  expect((await requestServeStop(f.root)).status).toBe("already_queued");
  expect(lstatSync(f.request).ino).toBe(before.ino);
  expect(readFileSync(f.request)).toEqual(data);
  expect(before.mode & 0o777).toBe(0o600); expect(before.nlink).toBe(1);
  expect(existsSync(f.stage)).toBe(false);
});

test("a request for a previous instance cannot stop or be removed by its successor", async () => {
  const f = fixture(); await requestServeStop(f.root);
  const next = { ...f.own, instance_id: crypto.randomUUID() };
  expect(serveStopRequested(f.root, next)).toBe(false);
  clearServeStopRequest(f.root, next); expect(existsSync(f.request)).toBe(true);
  writeFileSync(f.marker, JSON.stringify(next));
  await requestServeStop(f.root);
  expect(serveStopRequested(f.root, f.own)).toBe(false);
  clearServeStopRequest(f.root, f.own); expect(serveStopRequested(f.root, next)).toBe(true);
  clearServeStopRequest(f.root, next); expect(existsSync(f.request)).toBe(false);
});

test("writer contention retries and recognized abandoned staging is recoverable", async () => {
  const f = fixture(); writeFileSync(f.stage, bytes({ ...f.own, instance_id: crypto.randomUUID() }), { mode: 0o600 });
  const held = withVaultMutationSync({ vault_path: f.root }, async () => { await Bun.sleep(100); });
  const queued = requestServeStop(f.root);
  await held; expect((await queued).status).toBe("queued");
  expect(existsSync(f.stage)).toBe(false);
});

test("continued writer contention refuses the request after bounded retry", async () => {
  const f = fixture();
  await withVaultMutationSync({ vault_path: f.root }, async () => {
    await expect(requestServeStop(f.root)).rejects.toMatchObject({ code: "busy" });
    expect(existsSync(f.request)).toBe(false);
  });
});

for (const mode of ["symlink", "hardlink", "public", "malformed", "unknown-stage", "public-marker", "public-directory"])
  test(`unsafe stop control is refused without changing outside bytes: ${mode}`, async () => {
    const f = fixture(), outside = join(f.root, "outside"); writeFileSync(outside, bytes(f.own), { mode: 0o600 });
    const original = readFileSync(outside);
    if (mode === "symlink") symlinkSync(outside, f.request);
    if (mode === "hardlink") linkSync(outside, f.request);
    if (mode === "public") writeFileSync(f.request, bytes(f.own), { mode: 0o644 });
    if (mode === "malformed") writeFileSync(f.request, "unknown", { mode: 0o600 });
    if (mode === "unknown-stage") writeFileSync(f.stage, "unknown", { mode: 0o600 });
    if (mode === "public-marker") chmodSync(f.marker, 0o644);
    if (mode === "public-directory") chmodSync(join(f.root, ".kizuki"), 0o755);
    await expect(requestServeStop(f.root)).rejects.toMatchObject({ code: "unsafe" });
    expect(serveStopRequested(f.root, f.own)).toBe(false);
    expect(readFileSync(outside)).toEqual(original);
  });

test("a queued once-mode stop completes its active rail and closes before releasing its lease", async () => {
  const f = fixture(), db = openLedger(join(f.root, ".kizuki/kizuki.db"));
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let closes = 0;
  const running = runServeDaemon(db, f.root, { http: false, once: true, rails: ["sync", "brief"], acquireRuntime: async () => ({
    hooks: { sync: async () => { entered(); await barrier; return { events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0, errors: [] }; } },
    async close() { closes++; },
  }) });
  try {
    await ready;
    const current = readServeProcessMarker(f.root)!;
    expect((await requestServeStop(f.root)).instance_id).toBe(current.instance_id);
    expect(readServeProcessMarker(f.root)).toEqual(current);
    expect(readLease(db, "writer")).not.toBeNull();
    release(); await running;
    expect(closes).toBe(1); expect(listRunReceipts(db).map(x => x.rail)).toEqual(["sync"]);
    expect(readServeProcessMarker(f.root)).toBeNull(); expect(readLease(db, "writer")).toBeNull();
    expect(existsSync(f.request)).toBe(false);
  } finally { release(); await running; db.close(); }
});

test("invalid request data does not become a shutdown instruction between rails", async () => {
  const f = fixture(), db = openLedger(join(f.root, ".kizuki/kizuki.db"));
  try {
    writeFileSync(f.request, "not a control request", { mode: 0o600 });
    await runServeDaemon(db, f.root, { http: false, once: true, rails: ["doctor-sweep", "brief"] });
    expect(listRunReceipts(db)).toHaveLength(2);
    expect(readFileSync(f.request, "utf8")).toBe("not a control request");
  } finally { db.close(); }
});
