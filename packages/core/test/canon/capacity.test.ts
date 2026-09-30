import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewPurge } from "../../src/ledger/purge";
import { OWNER } from "../../src/agents";
import { serveSearch } from "../../src/serving/search";
import { rebuildDerived } from "../../src/derived";
import { worldFixture } from "../serving/world-fixture";
import { getClaim } from "../../src/claims/store";
import { pendingWorldCanonClaims, worldCanonTarget } from "../../src/canon/world-materialization";
import { applyCanonWrite } from "../../src/canon/apply";
import { CanonWriteError } from "../../src/canon/errors";
import { createBudgetTracker } from "../../src/canon/budget";
import { undoReceipt } from "../../src/canon/undo";
import { countUnwrittenLiveClaims } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { runWritePass } from "../../src/serve/write-pass";
import {
  DEFAULT_LIVE_PAGE_CEILING,
  LIVE_PAGE_CEILING_BOUNDS,
  canonCapacity,
  canonLimitsFor,
  loadCanonLimits,
  validateCanonLimits,
} from "../../src/vault/canon-limits";
import { serializePage } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { listCanonPagesReport } from "../../src/vault/pages";
import { putEvent } from "../claims/helpers";
import { storeClaim, write } from "./helpers";

// A loaded host walks slowly; these tests build hundreds of files.
setDefaultTimeout(120_000);

const roots: string[] = [];
const databases: ReturnType<typeof openLedger>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(ceiling?: number) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-canon-capacity-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  if (ceiling !== undefined) {
    writeFileSync(join(vault, ".kizuki", "serve.toml"), `[canon]\nmax_live_pages = ${ceiling}\n`, { mode: 0o600 });
  }
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  databases.push(db);
  return { vault, db, io: { db, vault_path: vault } };
}

/** Small valid pages written directly, standing in for a vault that grew. */
function fill(vault: string, count: number, status: "active" | "archived", prefix: string = status): void {
  const dir = join(vault, "bulk");
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const id = `bulk:${prefix}-${index}`;
    writeFileSync(join(dir, `${prefix}-${index}.md`), serializePage({
      data: { id, title: id, type: "fact", status, sensitivity: "personal", taint: "clean", sources: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] },
      body: "A synthetic note.\n",
    }));
  }
}

const capacityOf = (vault: string) => {
  const report = listCanonPagesReport(vault);
  return canonCapacity(report.pages, report.truncated, loadCanonLimits(vault));
};

describe("canon limits", () => {
  test("default to a ceiling above the old fixed bound and scale the walk with it", () => {
    const limits = canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING);
    expect(limits.live_pages).toBeGreaterThan(10_000);
    expect(limits.walk_files).toBe(2 * limits.live_pages);
    expect(canonLimitsFor(100).walk_files).toBe(limits.walk_files);
    expect(canonLimitsFor(200_000).walk_bytes).toBeGreaterThan(limits.walk_bytes);
    expect(canonLimitsFor(LIVE_PAGE_CEILING_BOUNDS.min).walk_bytes).toBeGreaterThanOrEqual(64 * 1_048_576);
  });

  test("read the vault's [canon] max_live_pages and ignore anything out of range", () => {
    const { vault } = fixture();
    const config = join(vault, ".kizuki", "serve.toml");
    expect(loadCanonLimits(vault).live_pages).toBe(DEFAULT_LIVE_PAGE_CEILING);
    for (const [text, expected] of [
      ["[canon]\nmax_live_pages = 150\n", 150],
      ["[canon]\nmax_live_pages = 5\n", DEFAULT_LIVE_PAGE_CEILING],
      ["[canon]\nmax_live_pages = 9999999\n", DEFAULT_LIVE_PAGE_CEILING],
      ["[canon]\nmax_live_pages = \"many\"\n", DEFAULT_LIVE_PAGE_CEILING],
      ["not toml [", DEFAULT_LIVE_PAGE_CEILING],
    ] as const) {
      writeFileSync(config, text);
      expect(loadCanonLimits(vault).live_pages).toBe(expected);
    }
  });
  test("backup canon limits reject malformed, excessive and unrelated configuration", () => {
    const valid = canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING);
    expect(validateCanonLimits(valid)).toEqual(valid);
    expect(validateCanonLimits(canonLimitsFor(LIVE_PAGE_CEILING_BOUNDS.max)).walk_bytes).toBe(1_073_741_824);
    for (const value of [null, {}, { ...valid, live_pages: 99 }, { ...valid, walk_files: 1_000_001 },
      { ...valid, walk_bytes: 1_073_741_825 }, { ...valid, walk_bytes: "65536" },
      { ...valid, endpoint: "https://synthetic.invalid" }]) {
      expect(() => validateCanonLimits(value)).toThrow("backup canon limits are invalid");
    }
  });

  test("explicit scan budgets are independent of writer capacity and bounded", () => {
    const { vault } = fixture(100);
    const config = join(vault, ".kizuki", "serve.toml");
    writeFileSync(config, "[canon]\nmax_live_pages = 100\nmax_scan_files = 500\nmax_scan_bytes = 65536\n");
    expect(loadCanonLimits(vault)).toMatchObject({ live_pages: 100, walk_files: 500, walk_bytes: 65536 });
    writeFileSync(config, "[canon]\nmax_scan_files = 1000001\nmax_scan_bytes = -1\n");
    expect(loadCanonLimits(vault)).toEqual(canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING));
  });

});

describe("live and archived counts", () => {
  test("archived pages are counted apart and never count against the ceiling", () => {
    const { vault } = fixture(100);
    fill(vault, 30, "active");
    fill(vault, 60, "archived");
    const capacity = capacityOf(vault);
    expect(capacity).toMatchObject({ live: 30, archived: 60, ceiling: 100, state: "ok", next: null });
    // 160 archived pages would be over the live ceiling if they counted; they only fill the walk.
    fill(vault, 100, "archived", "more");
    expect(capacityOf(vault)).toMatchObject({ live: 30, archived: 160, state: "ok" });
  });

  test("a low writer ceiling does not shrink reads or let archives hold creates", async () => {
    const { vault, db, io } = fixture(100);
    fill(vault, 30, "active");
    fill(vault, 250, "archived");
    const report = listCanonPagesReport(vault);
    expect(report.truncated).toBe(false);
    expect(capacityOf(vault)).toMatchObject({ live: 30, archived: 250, state: "ok" });
    const claim = await storeClaim(db, putEvent(db));
    expect(write(io, claim).page_action).toBe("create");
  });

  test("the live walk excludes archived pages while the maintenance walk keeps them", () => {
    const { vault } = fixture();
    fill(vault, 3, "active");
    fill(vault, 7, "archived");
    // The maintenance walk remains compatible for purge and receipt repair.
    expect(listCanonPagesReport(vault).pages).toHaveLength(10);
    expect(listCanonPagesReport(vault, undefined, { include_archived: false }).pages).toHaveLength(3);
  });

  test("near at 80 percent, full at the ceiling, each naming the next step", () => {
    const { vault } = fixture(100);
    fill(vault, 79, "active");
    expect(capacityOf(vault).state).toBe("ok");
    fill(vault, 1, "active", "eighty");
    expect(capacityOf(vault)).toMatchObject({ state: "near", live: 80 });
    fill(vault, 20, "active", "hundred");
    const full = capacityOf(vault);
    expect(full).toMatchObject({ state: "full", live: 100 });
    expect(full.next).toContain("max_live_pages");
    expect(full.next).toContain("[canon]");
  });

  test("archiving pages takes them out of the live count", () => {
    const { vault } = fixture(100);
    fill(vault, 100, "active");
    expect(capacityOf(vault).state).toBe("full");
    for (let index = 0; index < 40; index += 1) {
      const id = `bulk:active-${index}`;
      writeFileSync(join(vault, "bulk", `active-${index}.md`), serializePage({
        data: { id, title: id, type: "fact", status: "archived", sensitivity: "personal", taint: "clean", sources: [] },
        body: "A synthetic note.\n",
      }));
    }
    expect(capacityOf(vault)).toMatchObject({ live: 60, archived: 40, state: "ok" });
  });

  test("a walk that hit its resource bound reports an incomplete scan", () => {
    const { vault } = fixture(100);
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\nmax_scan_files = 200\n");
    fill(vault, 201, "archived");
    const report = listCanonPagesReport(vault);
    expect(report.truncated).toBe(true);
    expect(canonCapacity(report.pages, report.truncated, loadCanonLimits(vault)).state).toBe("scan_limited");
  });
});

describe("the writer at the ceiling", () => {
  test("receipted archiving frees a live slot and undo still works when that slot is used", async () => {
    const { vault, db, io } = fixture(100);
    const created = write(io, await storeClaim(db, putEvent(db)));
    fill(vault, 99, "active");
    expect(capacityOf(vault).state).toBe("full");

    const deletion = await storeClaim(db, putEvent(db), {
      kind: "deletion", predicate: null, object: null, body: "Archive the obsolete person page.",
    });
    const archived = write(io, deletion);
    expect(archived.page_action).toBe("archive");
    expect(archived.before_hash).toBe(created.after_hash);
    expect(capacityOf(vault)).toMatchObject({ live: 99, archived: 1, state: "near" });
    expect(listCanonPagesReport(vault, undefined, { include_archived: false }).pages
      .some(page => page.relPath === created.page_path)).toBe(false);

    const replacement = await storeClaim(db, putEvent(db), {
      target: "people/ada", subject: "person:ada", subjects: ["person:ada"], body: "Ada builds engines.",
      frontmatter: { type: "person", title: "Ada" },
    });
    expect(write(io, replacement).page_action).toBe("create");
    expect(capacityOf(vault)).toMatchObject({ live: 100, archived: 1, state: "full" });

    const reverted = await undoReceipt(io, archived.receipt_id);
    expect(reverted.after_hash).toBe(created.after_hash);
    expect(capacityOf(vault)).toMatchObject({ live: 101, archived: 0, state: "full" });
    expect(listCanonPagesReport(vault).truncated).toBe(false);
  });

  test("holds a new page under a named state while edits and reads continue", async () => {
    const { vault, db, io } = fixture(100);
    const first = await storeClaim(db, putEvent(db), { target: "people/grace" });
    const created = write(io, first);
    expect(created.page_action).toBe("create");
    fill(vault, 99, "active");
    expect(capacityOf(vault)).toMatchObject({ state: "full", live: 100 });

    const other = await storeClaim(db, putEvent(db), {
      target: "people/ada", subject: "person:ada", subjects: ["person:ada"], body: "Ada builds engines.",
      frontmatter: { type: "person", title: "Ada" },
    });
    let refusal: unknown;
    try { write(io, other); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(CanonWriteError);
    expect((refusal as CanonWriteError).code).toBe("canon_ceiling");
    expect((refusal as CanonWriteError).message).toContain("max_live_pages");
    expect(existsSync(join(vault, "people/ada.md"))).toBe(false);
    expect(existsSync(join(vault, created.page_path))).toBe(true);

    // An edit of an existing page adds no page and is not held.
    const edit = await storeClaim(db, putEvent(db), {
      kind: "edit", target: "people/grace", subject: "person:grace", predicate: "employment.role", object: "director",
      body: "Grace is a director at Acme.",
    });
    expect(write(io, edit).page_action).toBe("edit");

    // Reads walk the same vault and are unaffected.
    expect(listCanonPagesReport(vault).truncated).toBe(false);

    // Raising the ceiling releases the held page.
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 200\n");
    expect(write(io, other).page_action).toBe("create");
  });

  test("a write pass reports the held state once, keeps the claims live and writes edits", async () => {
    const { vault, db: originalDb } = fixture(100);
    let db = originalDb;
    const model = {
      descriptor: { id: "kizuki.producer.idle-test", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
      health: async () => ({ status: "ready", detail: {} }),
      close: async () => undefined,
      produce: async () => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
    } as never;
    const pass = () => runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "fixture:idle", producer: model, claims: { db },
    });
    const claim = (target: string, body: string) => storeClaim(db, putEvent(db), {
      kind: "entity", target, subject: null, subjects: [], predicate: null, object: null, body, frontmatter: { type: "topic", title: target },
    });
    await claim("topics/kept", "The kept topic.");
    expect((await pass()).canon_writes).toBe(1);
    fill(vault, 99, "active");

    for (let index = 0; index < 256; index++) await claim(`topics/held-${index}`, `Held topic ${index}.`);
    await claim("topics/kept", "The kept topic gained a note.");
    const result = await pass();
    expect(result.errors.filter((line) => line.includes("canon_ceiling"))).toHaveLength(1);
    expect(result.stopped).toBeNull();
    expect(existsSync(join(vault, "auto/topics/held-0.md"))).toBe(false);
    expect(existsSync(join(vault, "auto/topics/held-255.md"))).toBe(false);
    // An edit behind a full scan of held creates still receives its receipt.
    expect(result.canon_writes).toBe(1);
    expect(countUnwrittenLiveClaims(db)).toBe(256);
    expect((await pass()).canon_writes).toBe(0);
    databases.splice(databases.indexOf(db), 1);
    db.close();
    db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    databases.push(db);
    await claim("topics/kept", "The kept topic gained another note after restart.");
    expect((await pass()).canon_writes).toBe(1);
    expect(countUnwrittenLiveClaims(db)).toBe(256);
  });
  test("growing edits and archive transitions reserve bytes before publishing, while shrinking edits and undo work", async () => {
    const { vault, db, io } = fixture(100);
    const source = putEvent(db);
    const original = write(io, await storeClaim(db, source));
    fill(vault, 99, "active");
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\nmax_scan_bytes = 65536\n");
    const before = readFileSync(join(vault, original.page_path));
    const receipts = db.query("SELECT COUNT(*) AS n FROM canon_receipts").get();
    const large = await storeClaim(db, source, {
      kind: "edit", predicate: "employment.role", object: "large", body: "A synthetic note. ".repeat(5000),
    });
    expect(() => write(io, large)).toThrow(expect.objectContaining({ code: "canon_scan_incomplete" }));
    const deletion = await storeClaim(db, source, {
      kind: "deletion", predicate: null, object: null, frontmatter: { "x-notes": Array.from({ length: 24 }, (_, index) => `Note ${index}. ${"Synthetic. ".repeat(350)}`) },
    });
    expect(() => write(io, deletion)).toThrow(expect.objectContaining({ code: "canon_scan_incomplete" }));
    expect(readFileSync(join(vault, original.page_path))).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM canon_receipts").get()).toEqual(receipts);
    expect(db.query("SELECT COUNT(*) AS n FROM canon_write_intents").get()).toEqual({ n: 0 });
    expect(listCanonPagesReport(vault).truncated).toBe(false);
    await expect(serveSearch({ db, vaultPath: vault, principal: OWNER }, { query: "Grace" })).resolves.toBeDefined();
    expect(previewPurge(db, vault, { event_id: source }, "fixture cleanup").event_count).toBe(1);
    expect(() => rebuildDerived(db, vault)).not.toThrow();
    const small = await storeClaim(db, source, { kind: "edit", predicate: "employment.role", object: "small", body: "A note." });
    const edited = write(io, small);
    expect(edited.page_action).toBe("edit");
    await undoReceipt(io, edited.receipt_id);
    expect(readFileSync(join(vault, original.page_path))).toEqual(before);
  });

  test("a small edit cannot exhaust the remaining inventory bytes", async () => {
    const { vault, db, io } = fixture(100);
    const source = putEvent(db);
    const original = write(io, await storeClaim(db, source));
    fill(vault, 99, "active");
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\nmax_scan_bytes = 65536\n");
    const paddingPath = join(vault, "bulk", "active-0.md");
    const usage = listCanonPagesReport(vault).scanned_bytes;
    writeFileSync(paddingPath, Buffer.concat([readFileSync(paddingPath), Buffer.alloc(64_536 - usage, 0x78)]));
    expect(listCanonPagesReport(vault).scanned_bytes).toBe(64_536);
    const before = readFileSync(join(vault, original.page_path));
    const edit = await storeClaim(db, source, {
      kind: "edit", predicate: "employment.role", object: "revised", body: "A synthetic note. ".repeat(100),
    });
    expect(() => write(io, edit)).toThrow(expect.objectContaining({ code: "canon_scan_incomplete" }));
    expect(readFileSync(join(vault, original.page_path))).toEqual(before);
    expect(db.query("SELECT receipt_id FROM claims WHERE claim_id=?").get(edit.claim_id)).toEqual({ receipt_id: null });
    expect(listCanonPagesReport(vault).truncated).toBe(false);
    await expect(serveSearch({ db, vaultPath: vault, principal: OWNER }, { query: "Grace" })).resolves.toBeDefined();
    expect(previewPurge(db, vault, { event_id: source }, "fixture cleanup").event_count).toBe(1);
    expect(() => rebuildDerived(db, vault)).not.toThrow();
  });

  test("typed edits precede more held handles than a bounded typed pass can select, including restart", async () => {
    const { vault, db: initialDb } = fixture(100);
    let db = initialDb;
    const first = await worldFixture(db);
    const initial = first.claims.map(id => getClaim(db, id)!);
    applyCanonWrite({ db, vault_path: vault }, initial, worldCanonTarget(db, initial[0]!.claim_id), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });
    fill(vault, 99, "active");
    for (let index = 0; index < 34; index++) {
      await worldFixture(db, { sourceKey: first.sourceKey, subject: `topic:held-${index}`, label: `Synthetic held concept ${index}` });
    }
    const model = {
      descriptor: { id: "kizuki.producer.idle-test", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
      health: async () => ({ status: "ready", detail: {} }), close: async () => undefined,
      produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }),
    } as never;
    const pass = () => runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "fixture:idle", producer: model, claims: { db },
    });
    const changed = await worldFixture(db, { sourceKey: first.sourceKey, label: "Synthetic revised concept" });
    expect(pendingWorldCanonClaims(db, 1)[0]?.some(claim => changed.claims.includes(claim.claim_id))).toBe(true);
    expect((await pass()).canon_writes).toBe(1);
    expect((await pass()).canon_writes).toBe(0);
    databases.splice(databases.indexOf(db), 1);
    db.close();
    db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    databases.push(db);
    await worldFixture(db, { sourceKey: first.sourceKey, label: "Synthetic revised concept after restart" });
    expect((await pass()).canon_writes).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims WHERE is_world_typed=1 AND status='live' AND receipt_id IS NULL").get()?.n).toBeGreaterThanOrEqual(34);
  });

  test("creation cannot push a complete inventory past its resource budget", async () => {
    const { vault, db, io } = fixture(100);
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\nmax_scan_files = 100\n");
    fill(vault, 100, "archived");
    const claim = await storeClaim(db, putEvent(db));
    expect(() => write(io, claim)).toThrow(CanonWriteError);
    expect(listCanonPagesReport(vault).truncated).toBe(false);
    expect(inspectServeDoctor(db, vault).canon?.next).toContain("max_scan_files");

    // Byte admission also reserves room for the new image before publishing it.
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\nmax_scan_files = 500\nmax_scan_bytes = 65536\n");
    const large = await storeClaim(db, putEvent(db), {
      target: "topics/large", subject: null, predicate: null, object: null,
      body: "A synthetic note. ".repeat(4000), frontmatter: { type: "topic", title: "Large" },
    });
    expect(() => write(io, large)).toThrow(CanonWriteError);
    expect(listCanonPagesReport(vault).truncated).toBe(false);
    expect(existsSync(join(vault, "topics/large.md"))).toBe(false);
  });

  test("a resource-limited scan holds new writes without a receipt", async () => {
    const { vault, db, io } = fixture(100);
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\nmax_scan_files = 100\n");
    fill(vault, 101, "archived");
    const claim = await storeClaim(db, putEvent(db));
    let refusal: unknown;
    try {
      write(io, claim, { decision: { action: "create", rel_path: "people/grace.md" } });
    } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: "canon_scan_incomplete" });
    expect(existsSync(join(vault, "people/grace.md"))).toBe(false);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM canon_receipts").get()?.count).toBe(0);
    const report = inspectServeDoctor(db, vault);
    expect(report.canon?.state).toBe("scan_limited");
    expect(report.canon?.next).toContain("max_scan_files");
    expect(report.failures.some(line => line.includes("counts are incomplete"))).toBe(true);
  });

});

describe("doctor", () => {
  test("reports live and archived counts and the ceiling, and names the next step when full", () => {
    const { vault, db } = fixture(100);
    fill(vault, 10, "active");
    fill(vault, 5, "archived");
    const calm = inspectServeDoctor(db, vault);
    expect(calm.canon).toMatchObject({ state: "ok", live: 10, archived: 5, ceiling: 100, next: null });
    expect(calm.failures.some((line) => line.startsWith("canon "))).toBe(false);

    fill(vault, 70, "active", "near");
    const near = inspectServeDoctor(db, vault);
    expect(near.canon?.state).toBe("near");
    expect(near.failures.find((line) => line.startsWith("canon near"))).toContain("max_live_pages");

    fill(vault, 20, "active", "full");
    const full = inspectServeDoctor(db, vault);
    expect(full.canon).toMatchObject({ state: "full", live: 100, archived: 5 });
    const line = full.failures.find((text) => text.startsWith("canon full"));
    expect(line).toContain("100 live pages of 100, 5 archived");
    expect(line).toContain("new pages are held, reads continue");
    expect(line).toContain("next: raise max_live_pages under [canon] in .kizuki/serve.toml");
    expect(full.ok).toBe(false);
  });

  test("is null when the page walk was skipped", () => {
    const { vault, db } = fixture();
    expect(inspectServeDoctor(db, vault, { page_walk: false }).canon).toBeNull();
  });
});
