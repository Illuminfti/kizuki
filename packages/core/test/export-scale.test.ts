import { afterEach, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, exportVault, initVault, registerConnection, restoreVault, setSourceGrant } from "../src/index";
import * as grants from "../src/ledger/source-grants";
import { openLedger } from "../src/ledger/db";
import { loadCanonLimits } from "../src/vault/canon-limits";
import { listCanonPagesReport } from "../src/vault/pages";
import { serializePage } from "../src/vault/frontmatter";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";

setDefaultTimeout(120_000);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const policy = {
  purposes: ["capture", "recall", "session", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
};

test("export inspects each source grant once, not once per event, and finishes quickly", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-scale-"));
  dirs.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const keys = [ulid(), ulid(), ulid()];
    for (const key of keys) {
      registerConnection(db, "kizuki.fixture", key);
      setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: `grant-${key}`, policy });
    }
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        const result = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: `record-${i}`, text: `Synthetic evidence ${i}.` }, { source: { source_key: keys[i % 3]!, expected_revision: 1 } });
        if (result.status !== "stored") throw new Error("fixture event was not stored");
      }
    })();
    const inspect = spyOn(grants, "inspectSourceGrant");
    const started = performance.now();
    const manifest = exportVault(db, vault, join(root, "backup"));
    const seconds = (performance.now() - started) / 1000;
    expect(manifest.files["ledger/events.jsonl"]?.count).toBe(3000);
    expect(inspect.mock.calls.length).toBeLessThanOrEqual(10);
    expect(seconds).toBeLessThan(20);
    inspect.mockRestore();
    const restoreStarted = performance.now();
    restoreVault(join(root, "backup"), join(root, "restored"));
    expect((performance.now() - restoreStarted) / 1000).toBeLessThan(20);
  } finally { db.close(); }
});


test("canon above the default byte budget round-trips with canon-only limits before mandatory rebuilding", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-canon-resources-"));
  dirs.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  writeFileSync(join(vault, ".kizuki", "serve.toml"), '[canon]\nmax_live_pages = 100\nmax_scan_bytes = 268435456\n[model]\nbase_url = "https://model.invalid"\nsecret_ref = "env:SYNTHETIC_KEY"\n');
  mkdirSync(join(vault, "facts"), { recursive: true });
  for (let index = 0; index < 170; index++) {
    writeFileSync(join(vault, "facts", `large-${index}.md`), serializePage({
      data: { id: `fact:large-${index}`, type: "fact", title: "Synthetic note", status: "archived", sensitivity: "private", taint: "clean", sources: [] },
      body: "x".repeat(1_000_000),
    }));
  }
  expect(listCanonPagesReport(vault).scanned_bytes).toBeGreaterThan(163_840_000);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const backup = join(root, "backup");
    const manifest = exportVault(db, vault, backup);
    expect(manifest.files["canon/limits.json"]?.count).toBe(1);
    const restored = join(root, "restored");
    restoreVault(backup, restored, { rebuildDerived(_db, staging) {
      expect(loadCanonLimits(staging).walk_bytes).toBe(268435456);
      expect(listCanonPagesReport(staging).truncated).toBe(false);
    } });
    expect(loadCanonLimits(restored)).toEqual(loadCanonLimits(vault));
    expect(listCanonPagesReport(restored).pages).toHaveLength(170);
    expect(readFileSync(join(restored, ".kizuki", "serve.toml"), "utf8")).not.toMatch(/model|secret|endpoint/i);
    expect(readFileSync(join(restored, "facts", "large-0.md"))).toEqual(readFileSync(join(vault, "facts", "large-0.md")));
  } finally { db.close(); }
});


test("malformed backup canon limits refuse publication without echoing untrusted content", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-canon-invalid-"));
  dirs.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(":memory:");
  try {
    const backup = join(root, "backup");
    const manifest = exportVault(db, vault, backup);
    const content = Buffer.from('{"live_pages": "synthetic marker"');
    writeFileSync(join(backup, "canon", "limits.json"), content);
    manifest.files["canon/limits.json"] = {
      count: 1, mode: 0o600, size: content.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    };
    const { manifest_sha256: _hash, ...unsigned } = manifest;
    writeFileSync(join(backup, "manifest.json"), `${JSON.stringify({ ...unsigned,
      manifest_sha256: new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex"),
    }, null, 2)}\n`);
    let refusal: unknown;
    const destination = join(root, "restored");
    try { restoreVault(backup, destination); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe("backup canon limits are invalid");
    expect((refusal as Error).message).not.toContain("synthetic marker");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(root).filter(name => name.endsWith(".partial"))).toEqual([]);
  } finally { db.close(); }
});
