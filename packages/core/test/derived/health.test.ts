import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { rebuildDerived, refreshDerivedPage } from "../../src/derived";
import { readDerivedMeta } from "../../src/derived-meta";
import { latestLedgerCursor } from "../../src/ledger/ledger";
import { indexEvent } from "../../src/search/indexer";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { runRail } from "../../src/serve/rails";
import { serveSearch } from "../../src/serving/search";
import { serveGraph } from "../../src/serving/graph";
import { listCanonPagesReport } from "../../src/vault/pages";
import { recordedPage } from "../helpers/recorded-page";
import { searchDb, storedEvent, tempVault } from "../search/helpers";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function fixture() {
  const db = searchDb(), vault = tempVault();
  cleanup.push(() => { db.close(); vault.dispose(); });
  const ctx = { db, vaultPath: vault.path, principal: OWNER, now: () => "2026-09-29T12:00:00.000Z" };
  const doctor = () => inspectServeDoctor(db, vault.path, { host_checks: false }).stores;
  return { db, vaultPath: vault.path, ctx, doctor };
}
const data = { id: "fact:tea", title: "Tea", type: "fact", status: "active", sensitivity: "public", taint: "clean", subjects: ["person:ada"] };

test("daemon sourceless briefs do not degrade full or incremental indexes", async () => {
  const f = fixture();
  await runRail(f.db, f.vaultPath, "brief", { now: () => "2026-09-29T07:00:00.000Z", hooks: { model_ref: null } });
  const rebuilt = rebuildDerived(f.db, f.vaultPath);
  expect(rebuilt.search.status).toBe("ok");
  expect(rebuilt.graph.status).toBe("ok");
  const page = listCanonPagesReport(f.vaultPath).pages[0]!;
  refreshDerivedPage(f.db, page, f.vaultPath);
  for (const layer of ["search", "graph"] as const) expect(readDerivedMeta(f.db, layer)).toMatchObject({ status: "ok", skipped_count: 0 });
  const result = await serveSearch(f.ctx, { query: "brief" });
  expect(result.data?.degraded ?? []).not.toContain("index-degraded");
  expect(result.canon).toEqual([]);
});

test("incremental events advance the served search watermark and doctor", () => {
  const f = fixture();
  rebuildDerived(f.db, f.vaultPath);
  const event = storedEvent(f.db, "new-event");
  indexEvent(f.db, event);
  const cursor = latestLedgerCursor(f.db)!;
  const watermark = `${cursor.accepted_at}\t${cursor.event_id}`;
  expect(readDerivedMeta(f.db, "search")?.ledger_watermark).toBe(watermark);
  expect(f.doctor().derived.search).toMatchObject({ ledger_watermark: watermark, doc_count: 1, status: "ok" });
});

test("owner diagnostics name provenance skips and incremental repair clears both layers", async () => {
  const f = fixture();
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea with [[Kettle]].");
  const path = join(f.vaultPath, "facts/tea.md"), original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("Tea with", "Unrecorded tea with"));
  rebuildDerived(f.db, f.vaultPath);
  expect(f.doctor()).toMatchObject({ skipped_pages: [{ path: "facts/tea.md", reason: "revision_unrecorded" }], skipped_pages_total: 1 });
  for (const layer of ["search", "graph"] as const) expect(readDerivedMeta(f.db, layer)).toMatchObject({ status: "degraded", skipped_count: 1 });
  writeFileSync(path, original);
  refreshDerivedPage(f.db, listCanonPagesReport(f.vaultPath).pages[0]!, f.vaultPath);
  for (const layer of ["search", "graph"] as const) expect(readDerivedMeta(f.db, layer)).toMatchObject({ status: "ok", skipped_count: 0 });
  expect(f.doctor().skipped_pages_total).toBe(0);
});

test("hidden skips cannot change a reader's search or graph bytes", async () => {
  const f = fixture();
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea with [[Kettle]].");
  const token = addAgent(f.db, "reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["person:ada"] }).token;
  const reader = { ...f.ctx, principal: authenticate(f.db, token)! };
  rebuildDerived(f.db, f.vaultPath);
  const stable = <T extends { at: string }>(result: T) => ({ ...result, at: "fixed" });
  const before = stable(await serveSearch(reader, { query: "Tea" }));
  const beforeGraph = stable(await serveGraph(reader, { id: "fact:tea" }));
  await recordedPage(f.db, f.vaultPath, "facts/hidden.md", { ...data, id: "fact:hidden", sensitivity: "private", subjects: ["person:other"] }, "Hidden tea.");
  const path = join(f.vaultPath, "facts/hidden.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("Hidden tea.", "Hidden tea changed."));
  rebuildDerived(f.db, f.vaultPath);
  expect(stable(await serveSearch(reader, { query: "Tea" }))).toEqual(before);
  expect(stable(await serveGraph(reader, { id: "fact:tea" }))).toEqual(beforeGraph);
  expect((await serveSearch(f.ctx, { query: "Tea" })).data?.degraded).toContain("index-degraded");
});

test("graph skip status clears on repair without rebuilding", async () => {
  const f = fixture();
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea with [[Kettle]].");
  const path = join(f.vaultPath, "facts/tea.md"), original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("Tea with", "Changed tea with"));
  rebuildDerived(f.db, f.vaultPath);
  expect(readDerivedMeta(f.db, "graph")).toMatchObject({ status: "degraded", skipped_count: 1 });
  expect((await serveGraph(f.ctx, { id: "fact:tea" })).data?.degraded).toContain("index-degraded");
  writeFileSync(path, original);
  refreshDerivedPage(f.db, listCanonPagesReport(f.vaultPath).pages[0]!, f.vaultPath);
  expect(readDerivedMeta(f.db, "graph")).toMatchObject({ status: "ok", skipped_count: 0 });
});

test("an out-of-order incremental event cannot certify an unindexed gap", () => {
  const f = fixture();
  rebuildDerived(f.db, f.vaultPath);
  storedEvent(f.db, "gap");
  const second = storedEvent(f.db, "second");
  indexEvent(f.db, second);
  expect(readDerivedMeta(f.db, "search")?.ledger_watermark).toBeNull();
});

test("metadata and indexed events commit or roll back together", () => {
  const f = fixture();
  rebuildDerived(f.db, f.vaultPath);
  const prior = readDerivedMeta(f.db, "search");
  const event = storedEvent(f.db, "rollback");
  f.db.exec("CREATE TRIGGER reject_health BEFORE UPDATE ON derived_meta BEGIN SELECT RAISE(ABORT, 'synthetic health failure'); END");
  expect(() => indexEvent(f.db, event)).toThrow("synthetic health failure");
  expect(readDerivedMeta(f.db, "search")).toEqual(prior);
  expect(f.db.query("SELECT 1 FROM search_documents WHERE doc_id=?").get(`event:${event.event_id}`)).toBeNull();
});

test("doctor bounds provenance skips and preserves the total", async () => {
  const f = fixture();
  const { sourceIds } = await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea.");
  const { serializePage } = await import("../../src/vault/frontmatter");
  for (let n = 0; n < 18; n++) writeFileSync(join(f.vaultPath, `facts/skipped-${n}.md`), serializePage({ data: { ...data, id: `fact:skipped-${n}`, sources: sourceIds }, body: "Unrecorded tea." }));
  rebuildDerived(f.db, f.vaultPath);
  expect(f.doctor().skipped_pages_total).toBe(18);
  expect(f.doctor().skipped_pages).toHaveLength(16);
  for (const layer of ["search", "graph"] as const) expect(readDerivedMeta(f.db, layer)?.skipped_count).toBe(18);
});

test("sensitivity and subject exclusions independently preserve query bytes", async () => {
  const f = fixture();
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea with [[Kettle]].");
  const ceiling = authenticate(f.db, addAgent(f.db, "ceiling-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" }).token)!;
  const subject = authenticate(f.db, addAgent(f.db, "subject-reader", { ...OWNER_AGENT_GRANT, ceiling: "private", subjects: ["person:ada"] }).token)!;
  const stable = <T extends { at: string }>(result: T) => ({ ...result, at: "fixed" });
  rebuildDerived(f.db, f.vaultPath);
  for (const [principal, label, subjects] of [[ceiling, "private", ["person:ada"]], [subject, "public", ["person:other"]]] as const) {
    const ctx = { ...f.ctx, principal };
    const before = stable(await serveSearch(ctx, { query: "Tea" }));
    const graphBefore = stable(await serveGraph(ctx, { id: "fact:tea" }));
    if (principal.kind !== "agent") throw new Error("expected enrolled agent");
    const path = `facts/${principal.agent.name}.md`;
    await recordedPage(f.db, f.vaultPath, path, { ...data, id: `fact:${principal.agent.name}`, sensitivity: label, subjects: [...subjects] }, "Hidden tea.");
    const file = join(f.vaultPath, path);
    writeFileSync(file, readFileSync(file, "utf8").replace("Hidden tea.", "Hidden tea changed."));
    rebuildDerived(f.db, f.vaultPath);
    expect(stable(await serveSearch(ctx, { query: "Tea" }))).toEqual(before);
    expect(stable(await serveGraph(ctx, { id: "fact:tea" }))).toEqual(graphBefore);
  }
});

test("a missing ledger index flags only principals with visible evidence", async () => {
  const f = fixture();
  storedEvent(f.db, "hidden-event", { sensitivity_hint: "private" });
  const token = addAgent(f.db, "public-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" }).token;
  const reader = { ...f.ctx, principal: authenticate(f.db, token)! };
  rebuildDerived(f.db, f.vaultPath);
  f.db.exec("DROP TABLE search_docs");
  expect((await serveSearch(reader, { query: "kettle", scope: "ledger" })).data?.degraded ?? []).not.toContain("index-degraded");
  expect((await serveSearch(f.ctx, { query: "kettle", scope: "ledger" })).data?.degraded).toContain("index-degraded");
});

test("graph metadata already clears a repaired revision on the base", async () => {
  const f = fixture();
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea with [[Kettle]].");
  const path = join(f.vaultPath, "facts/tea.md"), original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("Tea with", "Changed tea with"));
  rebuildDerived(f.db, f.vaultPath);
  writeFileSync(path, original);
  refreshDerivedPage(f.db, listCanonPagesReport(f.vaultPath).pages[0]!, f.vaultPath);
  expect(readDerivedMeta(f.db, "graph")).toMatchObject({ status: "ok", skipped_count: 0 });
});

test("a receipted incremental canon write updates both layer counts", async () => {
  const f = fixture();
  rebuildDerived(f.db, f.vaultPath);
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea with [[Kettle]].");
  expect(readDerivedMeta(f.db, "search")).toMatchObject({ status: "ok", doc_count: 1, skipped_count: 0 });
  expect(readDerivedMeta(f.db, "graph")).toMatchObject({ status: "ok", doc_count: 3, source_count: 1, skipped_count: 0 });
});

test("adding a hidden root does not change an empty graph reply", async () => {
  const f = fixture();
  await recordedPage(f.db, f.vaultPath, "facts/tea.md", data, "Tea.");
  const file = join(f.vaultPath, "facts/tea.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("Tea.", "Unrecorded tea."));
  const token = addAgent(f.db, "root-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" }).token;
  const ctx = { ...f.ctx, principal: authenticate(f.db, token)! };
  const stable = <T extends { at: string }>(result: T) => ({ ...result, at: "fixed" });
  rebuildDerived(f.db, f.vaultPath);
  const before = stable(await serveGraph(ctx, { id: "fact:hidden" }));
  await recordedPage(f.db, f.vaultPath, "facts/hidden.md", { ...data, id: "fact:hidden", sensitivity: "private" }, "Hidden tea.");
  rebuildDerived(f.db, f.vaultPath);
  expect(stable(await serveGraph(ctx, { id: "fact:hidden" }))).toEqual(before);
});
