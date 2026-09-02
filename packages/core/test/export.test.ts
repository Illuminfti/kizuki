import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportVault } from "../src/export";
import { saveCheckpoint } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { purgeEvents } from "../src/ledger/purge";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";

const directories: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function populated() {
  const db = openLedger(":memory:");
  const vaultPath = temporary("kizuki-export-vault-");
  initVault(vaultPath);

  const first = accept(db, validEvent());
  const second = accept(db, { ...validEvent(), source_record_id: "rec-2" });
  if (first.status !== "stored" || second.status !== "stored") {
    throw new Error("expected stored events");
  }
  purgeEvents(db, vaultPath, { event_id: first.event.event_id }, "source erased");

  const sourceKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  db.query(
    "INSERT INTO connections (connector_id, source_key, config, secret_refs, connected_at, disconnected_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(
    "fixture",
    sourceKey,
    '{"schema":"kizuki.connection-config/v1","state_ref_index":null}',
    "[]",
    new Date().toISOString(),
  );
  saveCheckpoint(db, "fixture", sourceKey, "next", "sync", {
    stored: 1,
    duplicates: 0,
    errors: [],
    proposals_created: 1,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: "next",
  });
  writeFileSync(join(vaultPath, "notes.txt"), "plain vault file\n");
  writeFileSync(join(vaultPath, ".kizuki", "private-state"), "excluded\n");
  return { db, vaultPath };
}

describe("exportVault", () => {
  test("writes ledger and connection streams with matching manifest counts", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);

    expect(manifest.files["ledger/events.jsonl"]?.count).toBe(1);
    expect(manifest.files["ledger/event_purges.jsonl"]?.count).toBe(1);
    expect(manifest.files["connections.jsonl"]?.count).toBe(1);
    expect(manifest.files["checkpoints.jsonl"]?.count).toBe(1);
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toEqual(
      manifest,
    );
    db.close();
  });

  test("every manifest hash matches the bytes written", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);
    for (const [path, entry] of Object.entries(manifest.files)) {
      expect(
        new Bun.CryptoHasher("sha256")
          .update(readFileSync(join(outDir, path)))
          .digest("hex"),
      ).toBe(entry.sha256);
    }
    db.close();
  });

  test("copies ordinary vault files but excludes the control directory", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, outDir);
    expect(readFileSync(join(outDir, "vault", "notes.txt"), "utf8")).toBe(
      "plain vault file\n",
    );
    expect(existsSync(join(outDir, "vault", ".kizuki"))).toBe(false);
    expect(
      Object.keys(
        JSON.parse(readFileSync(join(outDir, "connections.jsonl"), "utf8")) as object,
      ),
    ).not.toContain("resolved_secret");
    db.close();
  });

  test("refuses a non-empty output directory without changing it", () => {
    const { db, vaultPath } = populated();
    const outDir = temporary("kizuki-export-nonempty-");
    const marker = join(outDir, "keep.txt");
    writeFileSync(marker, "keep\n");
    expect(() => exportVault(db, vaultPath, outDir)).toThrow(/not empty/);
    expect(readFileSync(marker, "utf8")).toBe("keep\n");
    db.close();
  });
});
