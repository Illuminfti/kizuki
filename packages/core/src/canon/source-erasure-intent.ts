import type { Database } from "bun:sqlite";
import { sha256Hex } from "../util/hash";
import { isPlainObject } from "../util/validate";
import { requireSourceEvents } from "../ledger/source-grants";
import {
  isLineageHash,
  isLineageId,
  isLineageTimestamp,
  lineageReceiptEarlier,
  parseSourceSurvivorLineage,
  type SourceSurvivorLineage,
} from "../ledger/canon-source-survivor-lineage";
import type { CanonReceipt } from "./receipts";
import { CanonAuthorityResolver } from "./authority";
import type { CanonIo } from "./store";
import { readOwnedCanonPage } from "./io";
import { openSourceErasureReceiptStream } from "./receipt-stream";
import { assertPageRelPath } from "./paths";
import { assertVaultMutationScope, type VaultMutationScope } from "../vault/mutation-scope";

const MAX_INTENT_BYTES = 256 * 1024;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const V1_KEYS = [
  "original_receipt_digest",
  "original_receipt_id",
  "page_id",
  "path_hash",
  "policies",
  "receipt",
  "source_key",
  "version",
] as const;
const V2_KEYS = [...V1_KEYS, "lineage"] as const;

interface PolicyBinding {
    source_key: string;
    status: string;
    revision: number;
    policy_digest: string;
    revoke_operation: string | null;
}

interface SourceErasureIntentV1 {
    version: 1;
    source_key: string;
    original_receipt_id: string;
    original_receipt_digest: string;
    path_hash: string;
    policies: PolicyBinding[];
    page_id: string | null;
    receipt: CanonReceipt;
}

interface SourceErasureIntentV2 extends Omit<SourceErasureIntentV1, "version"> {
    version: 2;
    lineage: SourceSurvivorLineage | null;
}

export type SourceErasureIntent = SourceErasureIntentV1 | SourceErasureIntentV2;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isLiveSurvivorReceipt(receipt: CanonReceipt): boolean {
    return receipt.kind === "purge_rewrite" &&
        receipt.page_action === "edit" &&
        receipt.archive_path === null &&
        receipt.reverts === null &&
        receipt.writer === "loop" &&
        receipt.producer === "deterministic" &&
        receipt.model_ref === null &&
        isLineageHash(receipt.before_hash) &&
        isLineageHash(receipt.after_hash);
}

function policies(db: Database, ids: readonly string[], denied: readonly string[]): PolicyBinding[] {
    const rows = new Map<string, PolicyBinding>();
    for (const id of ids) {
        const row = db.query<PolicyBinding, [
            string
        ]>("SELECT g.source_key,g.status,g.revision,g.policy_digest,g.revoke_operation FROM source_event_bindings b JOIN source_grants g ON g.source_key=b.source_key WHERE b.event_id=?").get(id);
        if (denied.includes(id) && (row === null || row.status === "active"))
            throw Error("source erasure authorization unavailable");
        if (row === null)
            continue; // Native owner evidence has no fabricated source grant.
        rows.set(row.source_key, row);
    }
    return [...rows.values()].sort((a, b) => a.source_key.localeCompare(b.source_key));
}

function originalRow(db: Database, receipt: CanonReceipt): Record<string, unknown> {
    const original = db.query<Record<string, unknown>, [
        string,
        string | null,
        string,
        string | null
    ]>("SELECT * FROM canon_receipts WHERE (page_path=? AND after_hash=?) OR (archive_path=? AND before_hash=?) ORDER BY at DESC,receipt_id DESC LIMIT 1").get(receipt.page_path, receipt.before_hash, receipt.page_path, receipt.before_hash);
    if (original === null)
        throw Error("source erasure original receipt unavailable");
    return original;
}

function liveSurvivorLineage(io: CanonIo, receipt: CanonReceipt, original: Record<string, unknown>): SourceSurvivorLineage {
    if (!isLiveSurvivorReceipt(receipt))
        throw Error("source erasure survivor receipt is invalid");
    try { assertPageRelPath(receipt.page_path); }
    catch { throw Error("source erasure survivor path is invalid"); }
    const originalId = original["receipt_id"];
    if (!isLineageId(originalId))
        throw Error("source erasure original receipt unavailable");
    if (original["page_path"] !== receipt.page_path)
        throw Error("source erasure predecessor is not the live page");
    const live = readOwnedCanonPage(io, receipt.page_path);
    if (live === null || live.hash !== receipt.before_hash)
        throw Error("source erasure preimage changed");
    const basis = new CanonAuthorityResolver(io.db, [receipt.page_path]).basis(receipt.page_path, live.hash);
    if (basis === null || basis.receipt_id !== originalId || basis.after_hash !== live.hash)
        throw Error("source erasure origin has no positive basis");
    const predecessorAt = original["at"];
    if (!isLineageTimestamp(predecessorAt) || !isLineageTimestamp(receipt.at) ||
        !lineageReceiptEarlier({ at: predecessorAt, receipt_id: originalId }, receipt))
        throw Error("source erasure chronology is invalid");
    return parseSourceSurvivorLineage({
        version: 1,
        kind: "source_survivor",
        child_receipt_id: receipt.receipt_id,
        predecessor_receipt_id: originalId,
        before_hash: receipt.before_hash,
        after_hash: receipt.after_hash,
        predecessor_effective_authority: basis.authority,
        result_authority: receipt.authority,
    });
}

function validateShape(intent: SourceErasureIntent): void {
    if (!isPlainObject(intent))
        throw Error("source erasure intent invalid");
    if (intent.version === 1) {
        if (!exactKeys(intent, V1_KEYS))
            throw Error("source erasure intent invalid");
        return;
    }
    if (intent.version === 2) {
        if (!exactKeys(intent, V2_KEYS))
            throw Error("source erasure intent invalid");
        if (intent.lineage !== null) parseSourceSurvivorLineage(intent.lineage);
        return;
    }
    throw Error("source erasure intent invalid");
}

function validate(db: Database, intent: SourceErasureIntent): void {
    validateShape(intent);
    if (intent.path_hash !== sha256Hex(intent.receipt.page_path) ||
        !intent.policies.some(row => row.source_key === intent.source_key))
        throw Error("source erasure intent invalid");
    const original = db.query("SELECT * FROM canon_receipts WHERE receipt_id=?").get(intent.original_receipt_id);
    if (original === null || sha256Hex(JSON.stringify(original)) !== intent.original_receipt_digest)
        throw Error("source erasure origin changed");
    for (const row of intent.policies) {
        const current = db.query<PolicyBinding, [
            string
        ]>("SELECT source_key,status,revision,policy_digest,revoke_operation FROM source_grants WHERE source_key=?").get(row.source_key);
        if (JSON.stringify(current) !== JSON.stringify(row))
            throw Error("source erasure authorization changed");
    }
    if (intent.receipt.page_action !== "archive")
        requireSourceEvents(db, intent.receipt.provenance, { owner: true, purpose: "derive" });
    if (intent.version === 2 && intent.lineage !== null) {
        const lineage = parseSourceSurvivorLineage(intent.lineage);
        if (lineage.child_receipt_id !== intent.receipt.receipt_id ||
            lineage.predecessor_receipt_id !== intent.original_receipt_id ||
            lineage.before_hash !== intent.receipt.before_hash ||
            lineage.after_hash !== intent.receipt.after_hash ||
            lineage.result_authority !== intent.receipt.authority ||
            !isLiveSurvivorReceipt(intent.receipt))
            throw Error("source erasure lineage invalid");
    }
    if (intent.version === 2 && intent.lineage === null && isLiveSurvivorReceipt(intent.receipt))
        throw Error("source erasure lineage invalid");
}

function parseIntentBytes(bytes: Uint8Array, digest: string): SourceErasureIntent {
    const json = FATAL_UTF8.decode(bytes);
    if (sha256Hex(json) !== digest)
        throw Error("source erasure intent corrupt");
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed))
        throw Error("source erasure intent invalid");
    return parsed as SourceErasureIntent;
}

function writeIntent(db: Database, intent: SourceErasureIntent): string {
    const json = JSON.stringify(intent);
    if (Buffer.byteLength(json, "utf8") > MAX_INTENT_BYTES)
        throw Error("source erasure intent exceeds bound");
    return json;
}

export function readSourceErasureIntent(db: Database, path: string): SourceErasureIntent | null {
    const row = db.query<{
        intent: Uint8Array | null;
        digest: string;
        source_key: string;
    }, [
        string
    ]>(`SELECT CASE WHEN typeof(intent)='text' AND length(CAST(intent AS BLOB))<=${MAX_INTENT_BYTES} THEN CAST(intent AS BLOB) ELSE NULL END AS intent,digest,source_key FROM canon_source_erasure_intents WHERE page_path=?`).get(path);
    if (row === null)
        return null;
    if (row.intent === null)
        throw Error("source erasure intent corrupt");
    const bytes = row.intent instanceof Uint8Array ? row.intent : Buffer.from(row.intent);
    const intent = parseIntentBytes(bytes, row.digest);
    if (intent.receipt.page_path !== path || intent.source_key !== row.source_key)
        throw Error("source erasure intent identity changed");
    validate(db, intent);
    return intent;
}

function coreEqual(left: SourceErasureIntent, right: SourceErasureIntent): boolean {
    return left.source_key === right.source_key &&
        left.original_receipt_id === right.original_receipt_id &&
        left.original_receipt_digest === right.original_receipt_digest &&
        left.path_hash === right.path_hash &&
        JSON.stringify(left.policies) === JSON.stringify(right.policies) &&
        left.page_id === right.page_id &&
        JSON.stringify(left.receipt) === JSON.stringify(right.receipt);
}

export function stageSourceErasureIntent(io: CanonIo, source: string, ids: readonly string[], receipt: CanonReceipt, pageId: string | null): SourceErasureIntent {
    const original = originalRow(io.db, receipt);
    const lineage = isLiveSurvivorReceipt(receipt) ? liveSurvivorLineage(io, receipt, original) : null;
    const next: SourceErasureIntentV2 = {
        version: 2,
        source_key: source,
        original_receipt_id: original["receipt_id"] as string,
        original_receipt_digest: sha256Hex(JSON.stringify(original)),
        path_hash: sha256Hex(receipt.page_path),
        policies: policies(io.db, [...new Set([...ids, ...receipt.provenance])], ids),
        page_id: pageId,
        receipt,
        lineage,
    };
    const pending = readSourceErasureIntent(io.db, receipt.page_path);
    if (pending !== null) {
        next.receipt = { ...receipt, receipt_id: pending.receipt.receipt_id, at: pending.receipt.at };
        if (next.lineage !== null) {
            next.lineage = parseSourceSurvivorLineage({
                ...next.lineage,
                child_receipt_id: next.receipt.receipt_id,
            });
        }
        if (pending.version === 1 && isLiveSurvivorReceipt(next.receipt)) {
            const upgraded = liveSurvivorLineage(io, next.receipt, original);
            next.lineage = upgraded;
            if (!coreEqual(pending, next) || pending.original_receipt_id !== next.original_receipt_id)
                throw Error("source erasure intent changed");
            validate(io.db, next);
            const json = writeIntent(next);
            io.db.query("UPDATE canon_source_erasure_intents SET intent=?,digest=? WHERE page_path=?").run(json, sha256Hex(json), receipt.page_path);
            return next;
        }
        if (pending.version === 1 && next.lineage === null && coreEqual(pending, next))
            return pending;
        if (JSON.stringify(next) !== JSON.stringify(pending))
            throw Error("source erasure intent changed");
        return pending;
    }
    validate(io.db, next);
    const json = writeIntent(next);
    io.db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run(receipt.page_path, source, json, sha256Hex(json));
    return next;
}
/** Held until the SQLite receipt/intent transaction commits or rolls back. */
export interface SourceErasureReceiptStream {
    verifyBinding(): void;
    close(): void;
}

/** The existing receipt stream remains authoritative; retry never adds a second same-ID line. */
export function appendSourceErasureReceipt(scope: VaultMutationScope, io: CanonIo, receipt: CanonReceipt): SourceErasureReceiptStream {
    assertVaultMutationScope(scope, io);
    const receiptId = receipt.receipt_id, expected = JSON.stringify(receipt);
    const stream = openSourceErasureReceiptStream(scope, io);
    try {
        const content = stream.readUtf8();
        let found = false;
        for (const line of content.split("\n")) {
            if (line === "") continue;
            const row = JSON.parse(line);
            if (row.receipt_id !== receiptId) continue;
            if (found || JSON.stringify(row) !== expected)
                throw Error("source erasure receipt conflict");
            found = true;
        }
        stream.verifyBinding();
        if (!found) stream.append(Buffer.from(`${expected}\n`));
        stream.sync();
        return Object.freeze({
            verifyBinding() { stream.verifyBinding(); },
            close() { stream.close(); },
        });
    } catch (error) {
        try { stream.close(); } catch { /* Retain the original refusal. */ }
        throw error;
    }
}
