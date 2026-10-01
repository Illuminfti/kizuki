import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { resolveTarget } from "../../src/canon/arbiter";
import { snapshotCanonIo, withCanonMutationSync } from "../../src/canon/io";
import * as projection from "../../src/canon/projection-obligations";
import { insertClaim } from "../../src/claims/store";
import { rebuildDerived, refreshDerivedPage } from "../../src/derived";
import { readDerivedMeta } from "../../src/derived-meta";
import * as graph from "../../src/graph/graph";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { serveGraph } from "../../src/serving/graph";
import { ulid } from "../../src/util/ulid";
import { listCanonPages } from "../../src/vault/pages";
import * as pages from "../../src/vault/pages";
import { serializePage } from "../../src/vault/frontmatter";
import { validEvent } from "../fixtures";
import { recordedPage } from "../helpers/recorded-page";
import { searchDb, tempVault } from "../search/helpers";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const DATA = { title: "Synthetic page", type: "fact", status: "active", sensitivity: "personal", taint: "clean" } as const;
const POLICY = {
  purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "personal",
};
function fixture() {
  const db = searchDb(), vault = tempVault();
  disposers.push(() => db.close(), vault.dispose);
  return { db, vault };
}
function rows(db: ReturnType<typeof searchDb>) { return db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all(); }

test("derive withdrawal reconciles affected admission and matches rebuilt public graph", async () => {
  const { db, vault } = fixture();
  const sources: { key: string; event: string }[] = [];
  for (const name of ["target", "origin"]) {
    const key = ulid(); registerConnection(db, "fixture", key);
    setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: `grant-${name}`, policy: POLICY });
    const event = accept(db, { ...validEvent(), source_record_id: name }, { source: { source_key: key, expected_revision: 1 } });
    if (event.status !== "stored") throw Error("fixture capture failed");
    sources.push({ key, event: event.event.event_id });
    await recordedPage(db, vault.path, `facts/${name}.md`, { ...DATA, id: `fact:${name}`, title: name },
      name === "origin" ? "See [[target]]." : "Target.", [event.event.event_id]);
  }
  rebuildDerived(db, vault.path);
  expect(rows(db)).toHaveLength(3);
  setSourceGrant(db, { source_key: sources[0]!.key, expected_revision: 1, operation_id: "narrow-target",
    policy: { ...POLICY, purposes: ["capture", "recall"] } });
  refreshDerivedPage(db, listCanonPages(vault.path).find(page => page.id === "fact:origin")!, vault.path);
  const incremental = rows(db);
  const context = { db, vaultPath: vault.path, principal: OWNER };
  const served = { ...await serveGraph(context, { id: "fact:origin" }), at: null };
  expect(incremental).toHaveLength(1);
  rebuildDerived(db, vault.path);
  expect(rows(db)).toEqual(incremental);
  expect({ ...await serveGraph(context, { id: "fact:origin" }), at: null }).toEqual(served);
  // Regrant also restores the target and incoming relations without a rebuild.
  setSourceGrant(db, { source_key: sources[0]!.key, expected_revision: 2, operation_id: "restore-target", policy: POLICY });
  refreshDerivedPage(db, listCanonPages(vault.path).find(page => page.id === "fact:origin")!, vault.path);
  expect(rows(db)).toHaveLength(3);
  const restored = rows(db); rebuildDerived(db, vault.path); expect(rows(db)).toEqual(restored);
});

test("a second consent change before reconciliation cannot be checkpointed past", async () => {
  const { db, vault } = fixture();
  const sources: { key: string; event: string }[] = [];
  for (const name of ["target", "origin", "healthy"]) {
    const key = ulid(); registerConnection(db, "fixture", key);
    setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: `grant-${name}`, policy: POLICY });
    const result = accept(db, { ...validEvent(), source_record_id: name }, { source: { source_key: key, expected_revision: 1 } });
    if (result.status !== "stored") throw Error("fixture capture failed");
    sources.push({ key, event: result.event.event_id });
    await recordedPage(db, vault.path, `facts/${name}.md`, { ...DATA, id: `fact:${name}`, title: name },
      name === "origin" ? "See [[target]]." : name, [result.event.event_id]);
  }
  rebuildDerived(db, vault.path);
  const narrow = (index: number) => setSourceGrant(db, { source_key: sources[index]!.key, expected_revision: 1,
    operation_id: `narrow-${index}`, policy: { ...POLICY, purposes: ["capture", "recall"] } });
  narrow(0);
  const original = graph.graphEvidenceChanges;
  let raced = false;
  const detect = spyOn(graph, "graphEvidenceChanges").mockImplementation(database => {
    const changed = original(database);
    if (!raced) { raced = true; narrow(1); }
    return changed;
  });
  try {
    await recordedPage(db, vault.path, "facts/healthy.md", { ...DATA, id: "fact:healthy", title: "healthy" },
      "Healthy revision.", [sources[2]!.event]);
  } finally { detect.mockRestore(); }
  expect(raced).toBe(true);
  const incremental = rows(db);
  expect(incremental).toHaveLength(1);
  rebuildDerived(db, vault.path); expect(rows(db)).toEqual(incremental);
});

test("a tombstone followed by an unrelated write removes stale source and incoming edges", async () => {
  const { db, vault } = fixture();
  const target = await recordedPage(db, vault.path, "facts/target.md", { ...DATA, id: "fact:target", title: "Target" }, "Target.");
  await recordedPage(db, vault.path, "facts/origin.md", { ...DATA, id: "fact:origin" }, "See [[Target]].");
  rebuildDerived(db, vault.path);
  const event = db.query<{ connector_id: string; source_record_id: string }, [string]>(
    "SELECT connector_id,source_record_id FROM events WHERE event_id=?").get(target.sourceIds[0]!)!;
  const deleted = accept(db, { ...validEvent(), ...event, deleted: true, text: "", occurred_at: "2030-01-01T00:00:00.000Z" });
  expect(deleted.status).toBe("stored");
  await recordedPage(db, vault.path, "facts/other.md", { ...DATA, id: "fact:other" }, "Unrelated.");
  const incremental = rows(db);
  const context = { db, vaultPath: vault.path, principal: OWNER };
  const served = { ...await serveGraph(context, { id: "fact:origin" }), at: null };
  expect(incremental).toHaveLength(2);
  rebuildDerived(db, vault.path); expect(rows(db)).toEqual(incremental);
  expect({ ...await serveGraph(context, { id: "fact:origin" }), at: null }).toEqual(served);
});

test("interrupted projection, unrelated write and retry preserve every unrelated edge", async () => {
  const { db, vault } = fixture();
  const write = (name: string) => recordedPage(db, vault.path, `facts/${name}.md`, { ...DATA, id: `fact:${name}` }, name);
  await write("one"); await write("two"); rebuildDerived(db, vault.path);
  const fail = spyOn(projection, "refreshCanonProjectionFloor").mockImplementation(() => { throw Error("synthetic interruption"); });
  try { await expect(write("three")).rejects.toThrow("synthetic interruption"); } finally { fail.mockRestore(); }
  await write("four");
  expect((await projection.retryCanonProjectionObligations({ db, vault_path: vault.path })).pending).toBe(0);
  const incremental = rows(db);
  expect(incremental).toHaveLength(4);
  expect(readDerivedMeta(db, "graph")?.status).toBe("ok");
  rebuildDerived(db, vault.path); expect(rows(db)).toEqual(incremental);
});

for (const locator of ["missing", "different identity"] as const) {
  test(`a moved explicit ID with a ${locator} locator retains owner-edit protection before derived refresh`, async () => {
    const { db, vault } = fixture();
    const written = await recordedPage(db, vault.path, "facts/target.md", { ...DATA, id: "fact:target" }, "Original.");
    rebuildDerived(db, vault.path);
    renameSync(join(vault.path, "facts/target.md"), join(vault.path, "facts/moved.md"));
    if (locator === "different identity") {
      writeFileSync(join(vault.path, "facts/target.md"), serializePage({
        data: { ...DATA, id: "fact:another", sources: written.sourceIds }, body: "Another page.",
      }), { mode: 0o600 });
    }
    const moved = readFileSync(join(vault.path, "facts/moved.md"));
    const filed = await insertClaim({ db }, { kind: "entity", target: "fact:target", body: "Replacement.", frontmatter: { type: "fact" },
      provenance: written.sourceIds, subjects: [], producer: "model", model_ref: "fixture:synthetic", confidence: 1,
      sensitivity: "personal", taint: "clean" });
    if (filed.outcome !== "stored") throw Error("fixture claim failed");
    expect(resolveTarget({ db, vault_path: vault.path }, filed.claim)).toEqual({ action: "skip", reason: "owner_edited_body" });
    const walk = spyOn(pages, "listCanonPagesReport");
    try {
      withCanonMutationSync(snapshotCanonIo({ db, vault_path: vault.path }), (_scope, owned) => {
        expect(resolveTarget(owned, filed.claim)).toEqual({ action: "skip", reason: "owner_edited_body" });
        expect(walk).not.toHaveBeenCalled();
      });
    } finally { walk.mockRestore(); }
    expect(existsSync(join(vault.path, "fact/target.md"))).toBe(false);
    expect(readFileSync(join(vault.path, "facts/moved.md"))).toEqual(moved);
  });
}
