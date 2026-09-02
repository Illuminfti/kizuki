import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { rowToReceipt } from "./canon/receipts";
import type { CanonReceiptRow } from "./canon/receipts";
import { listCheckpoints, listConnections } from "./ledger/connections";
import { replay } from "./ledger/ledger";
import { tableExists } from "./ledger/schema";

export interface ExportManifestEntry {
  count: number;
  sha256: string;
}

export interface ExportManifest {
  files: Record<string, ExportManifestEntry>;
}

interface PurgeRow {
  receipt_id: string;
  event_id: string;
  connector_id: string;
  reason: string;
  purged_at: string;
}

interface ProposalRow {
  proposal_id: string;
  kind: string;
  target: string | null;
  body: string;
  frontmatter: string;
  provenance: string;
  subjects: string;
  producer: string;
  confidence: number;
  status: string;
  created_at: string;
  body_hash: string;
}

interface RejectionRow {
  body_hash: string;
  reason: string;
  proposal_id: string;
  at: string;
}

function vaultFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (entry.name === ".kizuki") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...vaultFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256File(path: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(readFileSync(path))
    .digest("hex");
}

function jsonLines(rows: unknown[]): string {
  return rows.length === 0
    ? ""
    : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function prepareOutput(outDir: string): void {
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0) {
      throw new Error(`export output directory is not empty: ${outDir}`);
    }
    return;
  }
  mkdirSync(outDir, { recursive: true });
}

function proposals(db: Database): unknown[] {
  if (!tableExists(db, "proposals")) return [];
  return db
    .query<ProposalRow, []>(
      "SELECT * FROM proposals ORDER BY created_at, proposal_id",
    )
    .all()
    .map((row) => ({
      proposal_id: row.proposal_id,
      kind: row.kind,
      target: row.target,
      body: row.body,
      frontmatter: JSON.parse(row.frontmatter) as unknown,
      provenance: JSON.parse(row.provenance) as unknown,
      subjects: JSON.parse(row.subjects) as unknown,
      producer: row.producer,
      confidence: row.confidence,
      status: row.status,
      created_at: row.created_at,
      body_hash: row.body_hash,
    }));
}

function receipts(db: Database): unknown[] {
  if (!tableExists(db, "canon_receipts")) return [];
  return db
    .query<CanonReceiptRow, []>(
      "SELECT * FROM canon_receipts ORDER BY at, receipt_id",
    )
    .all()
    .map(rowToReceipt);
}

function rejections(db: Database): RejectionRow[] {
  if (!tableExists(db, "rejections")) return [];
  return db
    .query<RejectionRow, []>(
      "SELECT * FROM rejections ORDER BY at, proposal_id, body_hash",
    )
    .all();
}

export function exportVault(
  db: Database,
  vaultPath: string,
  outDir: string,
): ExportManifest {
  const sourceFiles = vaultFiles(vaultPath);
  prepareOutput(outDir);
  const manifest: ExportManifest = { files: {} };

  const track = (relativePath: string, count: number): void => {
    const path = join(outDir, relativePath);
    manifest.files[relativePath.split(sep).join("/")] = {
      count,
      sha256: sha256File(path),
    };
  };
  const writeJsonl = (relativePath: string, rows: unknown[]): void => {
    const path = join(outDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, jsonLines(rows));
    track(relativePath, rows.length);
  };

  for (const source of sourceFiles) {
    const relPath = relative(vaultPath, source);
    const destination = join(outDir, "vault", relPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    track(join("vault", relPath), 1);
  }

  writeJsonl("ledger/events.jsonl", [...replay(db, {})]);
  writeJsonl(
    "ledger/event_purges.jsonl",
    db
      .query<PurgeRow, []>(
        "SELECT * FROM event_purges ORDER BY purged_at, receipt_id",
      )
      .all(),
  );
  writeJsonl("staging/proposals.jsonl", proposals(db));
  writeJsonl("canon/receipts.jsonl", receipts(db));
  writeJsonl("staging/rejections.jsonl", rejections(db));
  writeJsonl(
    "connections.jsonl",
    listConnections(db, { includeDisconnected: true }),
  );
  writeJsonl("checkpoints.jsonl", listCheckpoints(db));

  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
