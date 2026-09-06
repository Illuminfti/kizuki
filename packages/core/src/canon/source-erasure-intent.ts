import type { Database } from "bun:sqlite";
import { sha256Hex } from "../util/hash";
import { requireSourceEvents } from "../ledger/source-grants";
import type { CanonReceipt } from "./receipts";
import type { CanonIo } from "./store";
import { openSourceErasureReceiptStream } from "./receipt-stream";
import { assertVaultMutationScope, type VaultMutationScope } from "../vault/mutation-scope";
interface PolicyBinding {
    source_key: string;
    status: string;
    revision: number;
    policy_digest: string;
    revoke_operation: string | null;
}
export interface SourceErasureIntent {
    version: 1;
    source_key: string;
    original_receipt_id: string;
    original_receipt_digest: string;
    path_hash: string;
    policies: PolicyBinding[];
    page_id: string | null;
    receipt: CanonReceipt;
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
function validate(db: Database, intent: SourceErasureIntent): void {
    if (intent.version !== 1 || intent.path_hash !== sha256Hex(intent.receipt.page_path) ||
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
}
export function readSourceErasureIntent(db: Database, path: string): SourceErasureIntent | null {
    const row = db.query<{
        intent: string;
        digest: string;
        source_key: string;
    }, [
        string
    ]>("SELECT intent,digest,source_key FROM canon_source_erasure_intents WHERE page_path=?").get(path);
    if (row === null)
        return null;
    if (row.intent.length > 256 * 1024 || sha256Hex(row.intent) !== row.digest)
        throw Error("source erasure intent corrupt");
    const intent = JSON.parse(row.intent) as SourceErasureIntent;
    if (intent.receipt.page_path !== path || intent.source_key !== row.source_key)
        throw Error("source erasure intent identity changed");
    validate(db, intent);
    return intent;
}
export function stageSourceErasureIntent(io: CanonIo, source: string, ids: readonly string[], receipt: CanonReceipt, pageId: string | null): SourceErasureIntent {
    const original = io.db.query<{
        receipt_id: string;
    }, [
        string,
        string | null,
        string,
        string | null
    ]>("SELECT * FROM canon_receipts WHERE (page_path=? AND after_hash=?) OR (archive_path=? AND before_hash=?) ORDER BY at DESC,receipt_id DESC LIMIT 1").get(receipt.page_path, receipt.before_hash, receipt.page_path, receipt.before_hash);
    if (original === null)
        throw Error("source erasure original receipt unavailable");
    const next: SourceErasureIntent = { version: 1, source_key: source, original_receipt_id: original.receipt_id,
        original_receipt_digest: sha256Hex(JSON.stringify(original)), path_hash: sha256Hex(receipt.page_path),
        policies: policies(io.db, [...new Set([...ids, ...receipt.provenance])], ids), page_id: pageId, receipt };
    const pending = readSourceErasureIntent(io.db, receipt.page_path);
    if (pending !== null) {
        next.receipt = { ...receipt, receipt_id: pending.receipt.receipt_id, at: pending.receipt.at };
        if (JSON.stringify(next) !== JSON.stringify(pending))
            throw Error("source erasure intent changed");
        return pending;
    }
    validate(io.db, next);
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 256 * 1024)
        throw Error("source erasure intent exceeds bound");
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
