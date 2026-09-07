import type { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertReceiptPaths } from "../canon/paths";
import { containedVaultFile } from "../vault/write";
import { isDeepStrictEqual } from "node:util";
import { applyPurgeRewrite, recoverSourceErasureIntents } from "../canon/apply";
import { getClaim } from "../claims/store";
import type { Claim } from "../contracts/proposal";
import { parseFrontmatter, type VaultPage } from "../vault/frontmatter";
import { stringArray } from "../vault/pages";
import { sha256Hex } from "../util/hash";
import { ulid } from "../util/ulid";

interface Receipt {
  receipt_id: string;
  page_path: string;
  archive_path: string | null;
  before_hash: string | null;
  after_hash: string;
  claim_ids: string;
  provenance: string;
}
function safePath(vault: string, relative: string): string | null {
  try { return containedVaultFile(vault, relative); }
  catch { return null; }
}

function replacement(
  page: VaultPage,
  claims: Claim[],
  affected: Set<string>,
): VaultPage | null | false {
  const present = claims.filter(
    (claim) =>
      claim.body.trim().length > 0 && page.body.includes(claim.body.trim()),
  );
  let unclaimed = page.body;
  for (const body of [
    ...new Set(present.map((claim) => claim.body.trim())),
  ].sort((a, b) => b.length - a.length))
    unclaimed = unclaimed.split(body).join("");
  if (unclaimed.trim().length > 0 || present.length === 0) return false;
  const independent = present.filter((claim) => !affected.has(claim.claim_id));
  const generated = new Set([
    "id",
    "type",
    "status",
    "sensitivity",
    "taint",
    "sources",
  ]);
  for (const [key, value] of Object.entries(page.data)) {
    if (generated.has(key)) continue;
    if (
      !present.some(
        (claim) =>
          isDeepStrictEqual(claim.frontmatter[key], value) ||
          (key === "x-subject-id" && claim.subject === value) ||
          (key === "title" &&
            claim.subject?.slice(claim.subject.indexOf(":") + 1) === value),
      )
    )
      return false;
  }
  if (independent.length === 0) return null;
  let body = page.body;
  for (const claim of present.filter((claim) => affected.has(claim.claim_id)))
    if (!independent.some((other) => other.body.includes(claim.body.trim())))
      body = body.split(claim.body.trim()).join("");
  const data = { ...page.data };
  for (const [key, value] of Object.entries(data)) {
    if (generated.has(key)) continue;
    if (
      !independent.some(
        (claim) =>
          isDeepStrictEqual(claim.frontmatter[key], value) ||
          (key === "x-subject-id" && claim.subject === value) ||
          (key === "title" &&
            claim.subject?.slice(claim.subject.indexOf(":") + 1) === value),
      )
    )
      delete data[key];
  }
  data["sources"] = [
    ...new Set(independent.flatMap((claim) => claim.provenance)),
  ];
  return { data, body };
}
/** All writes use the native canon capability; no payload preimage is made. */
export function eraseSourceCanon(
  db: Database,
  vault: string,
  source: string,
): boolean {
  if (!recoverSourceErasureIntents({db,vault_path:vault},source)) return false;
  const affected = new Set(
    db
      .query<{ claim_id: string }, [string]>(
        "SELECT DISTINCT c.claim_id FROM claims c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?",
      )
      .all(source)
      .map((row) => row.claim_id),
  );
  const eventIds = new Set(
    db
      .query<{ event_id: string }, [string]>(
        "SELECT event_id FROM source_event_bindings WHERE source_key=?",
      )
      .all(source)
      .map((row) => row.event_id),
  );
  const receipts = db
    .query<Receipt, [string]>(
      "SELECT * FROM canon_receipts WHERE page_path!='' AND page_path IN (SELECT c.page_path FROM canon_receipts c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?) ORDER BY at,receipt_id LIMIT 10001",
    )
    .all(source);
  if (receipts.length > 10000) return false;
  const work = new Map<string, { hashes: Set<string>; original: string }>();
  for (const receipt of receipts) {
    try { assertReceiptPaths(receipt); } catch { return false; }
    const current = work.get(receipt.page_path) ?? {
      hashes: new Set<string>(),
      original: receipt.page_path,
    };
    current.hashes.add(receipt.after_hash);
    work.set(receipt.page_path, current);
    if (receipt.archive_path !== null && receipt.before_hash !== null) {
      const archive = work.get(receipt.archive_path) ?? {
        hashes: new Set<string>(),
        original: receipt.page_path,
      };
      archive.hashes.add(receipt.before_hash);
      work.set(receipt.archive_path, archive);
    }
  }
  let safe = true;
  // Current canon first; archives have distinct paths but the same stored attribution.
  for (const [relative, entry] of work) {
    const path = safePath(vault, relative);
    if (path === null) {
      safe = false;
      continue;
    }
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.size > 1024 * 1024) {
      safe = false;
      continue;
    }
    const bytes = readFileSync(path);
    const hash = sha256Hex(bytes);
    if (!entry.hashes.has(hash)) {
      safe = false;
      continue;
    }
    let page: VaultPage;
    try {
      page = parseFrontmatter(bytes.toString("utf8"));
    } catch {
      safe = false;
      continue;
    }
    if (!stringArray(page.data["sources"]).some((id) => eventIds.has(id)))
      continue;
    const claimRows = db
      .query<{ claim_ids: string }, [string]>(
        "SELECT claim_ids FROM canon_receipts WHERE page_path=?",
      )
      .all(entry.original);
    const claims = [
      ...new Set(
        claimRows.flatMap((row) => JSON.parse(row.claim_ids) as string[]),
      ),
    ]
      .map((id) => getClaim(db, id))
      .filter((claim): claim is Claim => claim !== null);
    const next = replacement(page, claims, affected);
    if (next === false) {
      safe = false;
      continue;
    }
    try {
      applyPurgeRewrite(
        { db, vault_path: vault },
        {
          rel_path: relative,
          purged_event_ids: [...eventIds],
          purged_claim_ids: [...affected],
          purged_claim_bodies: [],
          source_erasure: {
            source_key: source,
            expected_hash: hash,
            page: next,
            retained_claim_ids:
              next === null
                ? []
                : claims
                    .filter(
                      (claim) =>
                        !affected.has(claim.claim_id) &&
                        next.body.includes(claim.body.trim()),
                    )
                    .map((claim) => claim.claim_id),
          },
        },
      );
    } catch {
      safe = false;
    }
  }
  if (!safe) return false;
  // Sanitization happens only after every managed copy was erased or retained independently.
  const all = db
    .query<Receipt, [string]>(
      "SELECT * FROM canon_receipts c WHERE EXISTS (SELECT 1 FROM json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?)",
    )
    .all(source);
  const selected = new Set([
    ...receipts.map((row) => row.receipt_id),
    ...all.map((row) => row.receipt_id),
  ]);
  const log = join(vault, ".kizuki", "receipts", "promotions.jsonl");
  if (existsSync(log)) {
    const safeLog = safePath(vault, ".kizuki/receipts/promotions.jsonl");
    if (safeLog === null || lstatSync(log).size > 32 * 1024 * 1024)
      return false;
    const lines = readFileSync(log, "utf8").split("\n");
    try {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === "") continue;
        const row = JSON.parse(lines[i]!);
        if (selected.has(row.receipt_id))
          lines[i] = JSON.stringify({
            ...Object.fromEntries(
              [
                "receipt_id",
                "kind",
                "claim_ids",
                "page_action",
                "before_hash",
                "after_hash",
                "writer",
                "authority",
                "confidence",
                "sensitivity",
                "taint",
                "provenance",
                "superseded",
                "retrieval_ops",
                "reverts",
                "reverted_by",
                "at",
              ]
                .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
                .map((key) => [key, row[key]]),
            ),
            page_path: "",
            archive_path: null,
            producer: "deterministic",
            model_ref: null,
            candidates: [],
          });
      }
    } catch {
      return false;
    }
    const temp = join(dirname(log), `.source-erasure-${ulid()}.tmp`);
    writeFileSync(temp, lines.join("\n"), { flag: "wx", mode: 0o600 });
    let fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, log);
    fd = openSync(dirname(log), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  db.transaction(() => {
    for (const receiptId of selected)
      db.query(
        "UPDATE canon_receipts SET page_path='',archive_path=NULL,producer='deterministic',model_ref=NULL,candidates='[]' WHERE receipt_id=?",
      ).run(receiptId);
  }).immediate();
  return true;
}
