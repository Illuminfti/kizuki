import { afterEach, expect, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import type { ProducerPort } from "../../src/contracts/producer";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { runWritePass } from "../../src/serve/write-pass";
import { QUARANTINE_MS, listQuarantinedPages } from "../../src/serve/write-quarantine";
import { worldFixture } from "../serving/world-fixture";
import { runRail } from "../../src/serve/rails";
import { getRunReceipt } from "../../src/serve/receipts";
import { serializePage } from "../../src/vault/frontmatter";
import { canonFixture } from "../canon/helpers";
import type { CanonFixture } from "../canon/helpers";
import { writeRailCursor } from "../../src/ledger/checkpoints";

const fixtures: CanonFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

test("malformed quarantine locators cannot hold a healthy page or enter doctor output", async () => {
  const f = canonFixture();
  fixtures.push(f);
  const created = await group(f, 0);
  const now = () => "2026-03-01T00:03:00.000Z";
  writeRailCursor(f.db, "kizuki.canon.writer", `stuck:${created.handle}`, JSON.stringify({
    path: `${created.path}\nSynthetic injected line.`, attempts: 3, reason: "fixture failure", last_at: now(),
  }));
  writeRailCursor(f.db, "kizuki.canon.writer", "stuck:invalid-handle", JSON.stringify({
    path: created.path, attempts: 3, reason: "fixture failure", last_at: now(),
  }));
  const overflow = "b".repeat(32);
  writeRailCursor(f.db, "kizuki.canon.writer", `stuck:${overflow}`, JSON.stringify({
    path: worldCanonPath(overflow), attempts: 3, reason: "fixture failure", last_at: "+275760-09-13T00:00:00.000Z",
  }));
  expect(inspectServeDoctor(f.db, f.vault, { now: now() }).quarantined.pages).toEqual([]);
  const written = await runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 40 }), model_ref: "fixture/model", claims: { db: f.db }, producer, now,
  });
  expect(written.canon_writes).toBe(1);
  expect(written.errors).toEqual([]);
});

const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => {},
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, dropped: [] }),
};

/** A typed page group, and the page path the writer would create for it. */
async function group(f: CanonFixture, index: number) {
  const world = await worldFixture(f.db, { subject: `topic:stuck-${index}`, label: `Stuck ${index}` });
  const handle = worldClaimHandle(f.db, world.claims[0]!)!;
  return { world, handle, path: worldCanonPath(handle) };
}

/** An unrecorded predecessor is preserved by the real writer and refuses this group. */
function unrecordedPredecessor(vault: string, path: string) {
  const file = join(vault, path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, serializePage({ data: {
    id: `topic:${path.slice("auto/world/".length, -3)}`, type: "topic", status: "active", sensitivity: "private", taint: "quoted", sources: [],
  }, body: "Synthetic unrecorded predecessor." }), { mode: 0o600 });
}

test("stuck typed pages do not starve a healthy one, and are set aside after three failed passes", async () => {
  const f = canonFixture();
  fixtures.push(f);
  const stuck = [];
  for (let index = 0; index < 33; index += 1) stuck.push(await group(f, index));
  const healthy = await group(f, 33);
  for (const page of stuck) unrecordedPredecessor(f.vault, page.path);
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const pass = () => runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 40 }),
    model_ref: "fixture/model", claims: { db: f.db }, producer, now: () => new Date(clock).toISOString(),
  });

  const first = await pass();
  expect(first.canon_writes).toBe(1);
  expect(healthy.world.claims.every(id => getClaim(f.db, id)!.receipt_id !== null)).toBe(true);
  expect(first.errors).toHaveLength(33);
  // Each failure names the page, so the owner can find what to fix.
  expect(first.errors[0]).toContain(`page ${stuck[0]!.handle} at ${stuck[0]!.path}`);
  expect(listQuarantinedPages(f.db, new Date(clock).toISOString())).toEqual([]);

  clock += 60_000;
  expect((await pass()).errors).toHaveLength(33);
  clock += 60_000;
  const third = await pass();
  expect(third.errors.filter(error => error.includes("set aside until"))).toHaveLength(33);
  const held = listQuarantinedPages(f.db, new Date(clock).toISOString());
  expect(held).toHaveLength(33);
  expect(held.every(page => page.attempts === 3 && page.path.startsWith("auto/world/"))).toBe(true);

  // Set aside means quiet: the stuck pages are not tried, so nothing fails, and a new healthy page still lands.
  const later = await group(f, 34);
  clock += 60_000;
  const fourth = await pass();
  expect(fourth.errors).toEqual([]);
  expect(fourth.canon_writes).toBe(1);
  expect(later.world.claims.every(id => getClaim(f.db, id)!.receipt_id !== null)).toBe(true);

  // A day on, each is tried once more; still failing, it is set aside for another day.
  clock += QUARANTINE_MS;
  const retry = await pass();
  expect(retry.errors.filter(error => error.includes("set aside until"))).toHaveLength(33);
  expect(listQuarantinedPages(f.db, new Date(clock).toISOString()).every(page => page.attempts === 4)).toBe(true);
}, 180_000);

test("a page that starts to write is cleared, and doctor lists what is set aside", async () => {
  const f = canonFixture();
  fixtures.push(f);
  const created = await group(f, 0);
  unrecordedPredecessor(f.vault, created.path);
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const now = () => new Date(clock).toISOString();
  const pass = () => runRail(f.db, f.vault, "sync", {
    hooks: { model_ref: "fixture/model", claims: { db: f.db }, producer }, now,
  });
  let receipt;
  for (let index = 0; index < 3; index += 1) { receipt = await pass(); clock += 60_000; }
  expect(getRunReceipt(f.db, receipt!.run_id)!.canon_quarantined).toEqual([{
    handle: created.handle, path: created.path, attempts: 3, until: "2026-03-02T00:02:00.000Z",
  }]);
  const report = inspectServeDoctor(f.db, f.vault, { now: now() });
  expect(report.quarantined.detail).toBe("quarantined typed pages=1");
  expect(report.quarantined.pages[0]).toMatchObject({ handle: created.handle, path: created.path, attempts: 3 });
  // The owner fixes what stuck it; after the day the page is tried, written, and forgotten.
  unlinkSync(join(f.vault, created.path));
  clock += QUARANTINE_MS;
  const written = await pass();
  expect(written.errors).toEqual([]);
  expect(written.canon_writes).toBe(1);
  expect(listQuarantinedPages(f.db, now())).toEqual([]);
  expect(inspectServeDoctor(f.db, f.vault, { now: now() }).quarantined.detail).toBe("quarantined typed pages=0");
}, 60_000);
