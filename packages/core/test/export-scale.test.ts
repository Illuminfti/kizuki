import { afterEach, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, exportVault, initVault, registerConnection, restoreVault, setSourceGrant } from "../src/index";
import * as grants from "../src/ledger/source-grants";
import { openLedger } from "../src/ledger/db";
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
