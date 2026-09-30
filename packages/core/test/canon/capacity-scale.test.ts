import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildDerived } from "../../src/derived";
import { exportVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { previewPurge, purgeEvents } from "../../src/ledger/purge";
import { rebuildRetrieval } from "../../src/retrieval/rebuild";
import { serveContextPacket } from "../../src/serving/packet";
import { serveSearch } from "../../src/serving/search";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { canonCapacity, loadCanonLimits } from "../../src/vault/canon-limits";
import { serializePage } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { listCanonPagesReport } from "../../src/vault/pages";
import { validEvent } from "../fixtures";
import { serveFixture, type Fixture } from "../serving/helpers";

// A loaded host reads this many files slowly.
setDefaultTimeout(120_000);

/** The fixed bound every earlier release refused at. */
const OLD_CEILING = 10_000;
const BULK = OLD_CEILING + 250;
const ARCHIVED = 300;

/** Small valid pages written directly, standing in for a vault that grew over years. */
function fill(vault: string, live: number, archived: number): void {
  const dir = join(vault, "bulk");
  mkdirSync(dir, { recursive: true });
  const put = (status: "active" | "archived", index: number): void => {
    const id = `bulk:${status}-${index}`;
    writeFileSync(join(dir, `${status}-${index}.md`), serializePage({
      data: { id, title: id, type: "fact", status, sensitivity: "personal", taint: "clean", sources: status === "archived" ? [] : ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] },
      body: "A synthetic note.\n",
    }));
  };
  for (let index = 0; index < live; index += 1) put("active", index);
  for (let index = 0; index < archived; index += 1) put("archived", index);
}

describe(`a vault above ${OLD_CEILING} canon files`, () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await serveFixture();
    fill(fixture.vaultPath, BULK, ARCHIVED);
    writeFileSync(join(fixture.vaultPath, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\n", { mode: 0o600 });
  });
  afterAll(() => fixture.dispose());

  test("the walk reads every file and reports live and archived apart", () => {
    const report = listCanonPagesReport(fixture.vaultPath);
    expect(report.truncated).toBe(false);
    expect(report.pages.length).toBeGreaterThan(OLD_CEILING);
    const capacity = canonCapacity(report.pages, report.truncated, loadCanonLimits(fixture.vaultPath));
    expect(capacity.state).toBe("full");
    expect(capacity.live).toBeGreaterThan(OLD_CEILING);
    expect(capacity.archived).toBeGreaterThanOrEqual(ARCHIVED);
  });

  test("query and context keep answering", async () => {
    const search = await serveSearch(fixture.owner(), { query: "kettle" });
    expect(search.canon.map((chunk) => chunk.page_id)).toContain("fact:kettle");
    const context = await serveContextPacket(fixture.owner(), { query: "kettle", budget_tokens: 2_000 });
    expect(context.data?.packet_md).toContain("KIZUKI CONTEXT v1");
    expect(context.data?.retrieval_degraded ?? []).toEqual([]);
  });

  // The bulk files have no canon receipt, so the index withholds them by design; what
  // the rebuild proves here is that it reads the whole vault instead of refusing it.
  test("rebuild reads the whole vault and indexes the receipted pages", async () => {
    const floor = rebuildDerived(fixture.db, fixture.vaultPath);
    expect(floor.search.pages).toBeGreaterThan(0);
    expect(floor.search.skipped.some((entry) => entry.code === "too_many")).toBe(false);
    const rebuilt = await rebuildRetrieval(fixture.db, fixture.vaultPath);
    expect(rebuilt.backend).toBe("sqlite-floor");
    expect(rebuilt.floor_documents).toBeGreaterThan(0);
    const search = await serveSearch(fixture.owner(), { query: "kettle" });
    expect(search.canon.map((chunk) => chunk.page_id)).toContain("fact:kettle");
  });

  test("purge enumerates every page", () => {
    const preview = previewPurge(fixture.db, fixture.vaultPath, { event_id: Object.values(fixture.events)[0]! }, "cleanup");
    expect(preview.event_count).toBe(1);
  });

  test("doctor reports the counts against the configured ceiling", () => {
    const report = inspectServeDoctor(fixture.db, fixture.vaultPath);
    expect(report.canon?.state).toBe("full");
    expect(report.canon?.live).toBeGreaterThan(OLD_CEILING);
    expect(report.canon?.archived).toBeGreaterThanOrEqual(ARCHIVED);
    expect(report.canon?.ceiling).toBe(100);
  });
});

describe(`export and purge on a vault above ${OLD_CEILING} canon files`, () => {
  let root: string;
  let vault: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "kizuki-canon-scale-"));
    vault = join(root, "vault");
    initVault(vault);
    fill(vault, BULK, ARCHIVED);
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\n", { mode: 0o600 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Exercise the large read at the public export seam. Small export tests cover
  // durable copying/publication; syncing thousands of copies exceeds the shared
  // machine's per-test deadline. Cancellation also proves staging cleanup.
  test("export enumerates and hashes every page before payload copying", () => {
    const db = openLedger(":memory:");
    const controller = new AbortController();
    let inventory: { files: { kind: string; sha256: string }[] } | undefined;
    try {
      expect(() => exportVault(db, vault, join(root, "backup"), {
        signal: controller.signal,
        onProgress(label) {
          if (label !== "inventory") return;
          const name = readdirSync(root).find(entry => entry.includes(".kizuki-backup-"));
          if (name === undefined) throw new Error("expected private export staging");
          const staged = join(root, name);
          inventory = JSON.parse(readFileSync(join(staged, "export-inventory.json"), "utf8"));
          expect(existsSync(join(staged, "vault"))).toBe(false);
          controller.abort();
        },
      })).toThrow("export cancelled");
    } finally {
      db.close();
    }
    const canon = inventory?.files.filter(file => file.kind === "canon");
    expect(canon).toHaveLength(BULK + ARCHIVED);
    expect(canon?.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(existsSync(join(root, "backup"))).toBe(false);
    expect(readdirSync(root).filter(entry => entry.includes(".kizuki-backup-"))).toEqual([]);
  });

  test("purge removes an event and enumerates the vault to do it", () => {
    const db = openLedger(":memory:");
    try {
      const stored = accept(db, { ...validEvent(), source_record_id: "scale.md" });
      if (stored.status !== "stored") throw new Error("expected stored event");
      const outcome = purgeEvents(db, vault, { event_id: stored.event.event_id }, "cleanup");
      expect(outcome.receipts).toHaveLength(1);
      expect(db.query("SELECT event_id FROM events WHERE event_id = ?").get(stored.event.event_id)).toBeNull();
    } finally {
      db.close();
    }
  });
});
