import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_SCHEMA,
  exportVault,
  restoreVault,
  verifyBackup,
} from "../src/export";
import { saveCheckpoint } from "../src/ledger/connections";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { purgeEvents } from "../src/ledger/purge";
import { readVaultId } from "../src/serve/vault-id";
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
  writeFileSync(join(vaultPath, "z-last.txt"), "z\n");
  writeFileSync(join(vaultPath, "ä-umlaut.txt"), "ae\n");
  mkdirSync(join(vaultPath, "people"), { recursive: true });
  writeFileSync(join(vaultPath, "people", "Ada.md"), "---\nid: ada\n---\n");
  writeFileSync(join(vaultPath, ".kizuki", "private-state"), "excluded\n");
  return { db, vaultPath, remainingEventId: second.event.event_id };
}

describe("exportVault", () => {
  test("writes a complete kizuki.backup/v1 manifest with matching hashes", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);

    expect(manifest.schema).toBe(BACKUP_SCHEMA);
    expect(manifest.complete).toBe(true);
    expect(manifest.schema_versions.ledger).toBe(LEDGER_SCHEMA_VERSION);
    expect(manifest.files["ledger/events.jsonl"]?.count).toBe(1);
    expect(manifest.files["ledger/event_purges.jsonl"]?.count).toBe(1);
    expect(manifest.files["connections.jsonl"]?.count).toBe(1);
    expect(manifest.files["checkpoints.jsonl"]?.count).toBe(1);
    expect(manifest.snapshot.event_count).toBe(1);
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toEqual(
      manifest,
    );
    expect(verifyBackup(outDir).manifest_sha256).toBe(manifest.manifest_sha256);
    for (const [path, entry] of Object.entries(manifest.files)) {
      expect(
        new Bun.CryptoHasher("sha256")
          .update(readFileSync(join(outDir, path)))
          .digest("hex"),
      ).toBe(entry.sha256);
      expect(lstatSync(join(outDir, path)).mode & 0o777).toBe(0o600);
    }
    expect(lstatSync(outDir).mode & 0o777).toBe(0o700);
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
    expect(readFileSync(join(outDir, "connections.jsonl"), "utf8")).not.toContain(
      "resolved_secret",
    );
    db.close();
  });

  test("orders vault files by Unicode code unit, not locale", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);
    const vaultKeys = Object.keys(manifest.files).filter((key) =>
      key.startsWith("vault/"),
    );
    expect(vaultKeys).toEqual([...vaultKeys].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ));
    expect(vaultKeys.indexOf("vault/z-last.txt")).toBeLessThan(
      vaultKeys.indexOf("vault/ä-umlaut.txt"),
    );
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

  test("removes the staging directory when export is cancelled", () => {
    const { db, vaultPath } = populated();
    const parent = temporary("kizuki-export-parent-");
    const outDir = join(parent, "dump");
    expect(() =>
      exportVault(db, vaultPath, outDir, {
        onProgress: (label) => {
          if (label === "vault") throw new Error("injected failure");
        },
      }),
    ).toThrow(/injected failure/);
    expect(existsSync(outDir)).toBe(false);
    expect(
      readdirSync(parent).some((name) => name.includes(".kizuki-backup-")),
    ).toBe(false);
    db.close();
  });

  test("refuses a destination inside the vault, including through a symlink", () => {
    const { db, vaultPath } = populated();
    expect(() => exportVault(db, vaultPath, join(vaultPath, "inside"))).toThrow(
      /must not be inside the vault/,
    );
    const parent = temporary("kizuki-export-alias-");
    const alias = join(parent, "alias");
    symlinkSync(vaultPath, alias);
    expect(() => exportVault(db, vaultPath, join(alias, "nested"))).toThrow(
      /must not be inside the vault/,
    );
    db.close();
  });

  test("writes owner-only files even under a permissive umask", () => {
    const { db, vaultPath } = populated();
    const previous = process.umask(0o000);
    try {
      const outDir = join(temporary("kizuki-export-parent-"), "dump");
      exportVault(db, vaultPath, outDir);
      expect(lstatSync(outDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(outDir, "manifest.json")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(outDir, "ledger", "events.jsonl")).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      process.umask(previous);
    }
    db.close();
  });

  test("refuses an existing destination that is world-accessible", () => {
    const { db, vaultPath } = populated();
    const outDir = temporary("kizuki-export-open-");
    chmodSync(outDir, 0o777);
    expect(() => exportVault(db, vaultPath, outDir)).toThrow(/owner-only/);
    db.close();
  });

  test("streams a large vault file without retaining the whole payload", () => {
    const { db, vaultPath } = populated();
    const blob = Buffer.alloc(4 * 1024 * 1024, 7);
    writeFileSync(join(vaultPath, "blob.bin"), blob);
    const before = process.memoryUsage().rss;
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);
    const after = process.memoryUsage().rss;
    expect(manifest.files["vault/blob.bin"]?.size).toBe(blob.byteLength);
    expect(after - before).toBeLessThan(48 * 1024 * 1024);
    db.close();
  });
});

describe("restoreVault", () => {
  test("restores ledger rows and vault bytes into a clean target", () => {
    const { db, vaultPath, remainingEventId } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    const report = restoreVault(backup, target);

    expect(report.events).toBe(1);
    expect(report.vault_files).toBeGreaterThan(0);
    expect(readFileSync(join(target, "notes.txt"), "utf8")).toBe(
      "plain vault file\n",
    );
    expect(existsSync(join(target, ".kizuki"))).toBe(true);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(
      restored
        .query<{ event_id: string }, []>("SELECT event_id FROM events")
        .all()
        .map((row) => row.event_id),
    ).toEqual([remainingEventId]);
    expect(
      restored
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM event_purges")
        .get()?.count,
    ).toBe(1);
    expect(
      restored
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM connections")
        .get()?.count,
    ).toBe(1);
    restored.close();
    db.close();
  });

  test("verify-only refuses a torn or incomplete backup", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    writeFileSync(join(backup, "INCOMPLETE"), "incomplete\n");
    expect(() => verifyBackup(backup)).toThrow(/incomplete/);
    rmSync(join(backup, "INCOMPLETE"));
    writeFileSync(join(backup, "ledger", "events.jsonl"), "{not-json\n", {
      flag: "w",
    });
    expect(() => verifyBackup(backup)).toThrow(/hash mismatch/);
    db.close();
  });

  test("refuses restore into an existing populated target", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = temporary("kizuki-restore-occupied-");
    writeFileSync(join(target, "keep.txt"), "keep\n");
    expect(() => restoreVault(backup, target)).toThrow(/not empty/);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
    db.close();
  });

  test("preserves vault identity when the source had one", () => {
    const { db, vaultPath } = populated();
    writeFileSync(join(vaultPath, ".kizuki", "vault-id"), "01exportvaultid000000000001\n");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    expect(manifest.vault_id).toBe("01exportvaultid000000000001");
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    expect(readVaultId(target)).toBe("01exportvaultid000000000001");
    db.close();
  });
});
