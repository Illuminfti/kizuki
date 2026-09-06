// Root integration probe: proposed SQL only; baseline authority parents are explicit stubs.
// It does not claim a real migration or application codec validation.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

if (process.argv.length > 3) throw new Error("optional argument is one appendix snapshot path");
const mapPath = process.argv[2] ?? new URL("../0004-world-storage.md", import.meta.url);
const markdown = await Bun.file(mapPath).text();
const sql = [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)]
  .map((match) => match[1])
  .join("\n");
function markedTextFragment(marker: string): string {
  const matches = [...markdown.matchAll(new RegExp(`<!-- ${marker} -->\\n\`\`\`text\\n([\\s\\S]*?)\`\`\``, "g"))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) throw new Error(`expected exactly one ${marker}`);
  return matches[0][1];
}
const eventOriginTarget = markedTextFragment("events-id-origin-target-fragment");
const eventOriginTrigger = markedTextFragment("events-id-origin-target-trigger");
console.log(`APPENDIX_SHA256=${createHash("sha256").update(markdown).digest("hex")}`);
console.log(`EXTRACTED_SQL_SHA256=${createHash("sha256").update(sql).digest("hex")}`);
console.log(`EVENT_ORIGIN_TARGET_SHA256=${createHash("sha256").update(eventOriginTarget).digest("hex")}`);
console.log(`EVENT_ORIGIN_TRIGGER_SHA256=${createHash("sha256").update(eventOriginTrigger).digest("hex")}`);

const db = new Database(":memory:");
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE claims(claim_id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE events(
    event_id TEXT PRIMARY KEY,
    content_hash_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    origin_binding TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
${eventOriginTarget}
  ) STRICT;
  CREATE TABLE source_event_bindings(
    event_id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    grant_revision INTEGER NOT NULL,
    policy_digest TEXT NOT NULL
  ) STRICT;
  CREATE TABLE source_grants(source_key TEXT PRIMARY KEY) STRICT;
  CREATE TABLE page_index(page_id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE event_purges(receipt_id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE canon_receipts(receipt_id TEXT PRIMARY KEY) STRICT;
  ${eventOriginTrigger}
`);
db.exec(sql);
console.log("DDL_PARSE_PASS");

type IndexRow = { name: string; unique: number; partial: number };
type IndexColumn = { name: string; seqno: number };
type TableColumn = { name: string; pk: number };
type ForeignKey = { id: number; seq: number; table: string; from: string; to: string };

function uniqueKeys(table: string): string[][] {
  const columns = db.query<TableColumn, []>(`PRAGMA table_info('${table}')`).all();
  const primary = columns
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => name);
  const keys = primary.length > 0 ? [primary] : [];
  for (const index of db.query<IndexRow, []>(`PRAGMA index_list('${table}')`).all()) {
    if (index.unique !== 1 || index.partial !== 0) continue;
    keys.push(
      db.query<IndexColumn, []>(`PRAGMA index_info('${index.name}')`).all()
        .sort((left, right) => left.seqno - right.seqno)
        .map(({ name }) => name),
    );
  }
  return keys;
}

const tables = db.query<{ name: string }, []>(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
).all();
for (const { name: child } of tables) {
  const groups = new Map<number, ForeignKey[]>();
  for (const foreignKey of db.query<ForeignKey, []>(`PRAGMA foreign_key_list('${child}')`).all()) {
    const group = groups.get(foreignKey.id) ?? [];
    group.push(foreignKey);
    groups.set(foreignKey.id, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.seq - right.seq);
    const parent = group[0]!.table;
    const target = group.map(({ to }) => to);
    const matched = uniqueKeys(parent).some(
      (key) => key.length === target.length && key.every((column, index) => column === target[index]),
    );
    if (!matched) throw new Error(`invalid foreign-key target: ${child} -> ${parent}(${target.join(",")})`);
  }
}
console.log("FK_TARGETS_PASS");

for (const [table, forbidden] of [
  ["world_authorization_namespaces", "key_version"],
  ["world_wire_refs", "target_integrity"],
  ["world_view_runtime", "token_key_version"],
  ["world_scoped_tokens", "token_key_version"],
] as const) {
  const columns = new Set(
    db.query<TableColumn, []>(`PRAGMA table_info('${table}')`).all().map(({ name }) => name),
  );
  if (columns.has(forbidden)) throw new Error(`${table}.${forbidden} unexpectedly remains`);
}
console.log("NO_UNSPECIFIED_WIRE_KEY_CUSTODY_PASS");

db.exec(`
  INSERT INTO core_authority_commits(admission_seq,admitted_at,operation_id,id_origin,id_allocator_version) VALUES
    (1,'2026-09-05T12:00:00.000Z','00000000000000000000060001','core_allocated',1),
    (2,'2026-09-05T12:00:00.000Z','00000000000000000000060002','core_allocated',1);
  INSERT INTO claims(claim_id) VALUES ('c1'),('c2');
  INSERT INTO claim_v2_support(
    support_id,claim_id,codec,support_key,admission_key,admission_seq,admitted_at,effect_ordinal,
    epistemic_kind,authority,confidence,sensitivity,payload,rendering
  ) VALUES
    ('s1','c1','kizuki.claim-admission/v1',lower(hex(randomblob(32))),lower(hex(randomblob(32))),
     1,'2026-09-05T12:00:00.000Z',0,'observed','owner_authored',1,'private','{}','x'),
    ('s2','c2','kizuki.claim-admission/v1',lower(hex(randomblob(32))),lower(hex(randomblob(32))),
     2,'2026-09-05T12:00:00.000Z',0,'observed','owner_authored',1,'private','{}','x');
  INSERT INTO claim_support_dependencies VALUES ('c1','s1','c2','s2');
`);
let cycleRejected = false;
try {
  db.exec("INSERT INTO claim_support_dependencies VALUES ('c2','s2','c1','s1')");
} catch {
  cycleRejected = true;
}
if (!cycleRejected) throw new Error("dependency cycle was accepted");
console.log("CYCLE_TRIGGER_PASS");

db.exec("INSERT INTO event_purges(receipt_id) VALUES ('p1'),('p2')");
db.query(`
  INSERT INTO claims_v4(
    claim_id,id_origin,id_allocator_version,row_state,sensitivity,purge_receipt_id,erased_at,tombstone_integrity
  ) VALUES ('00000000000000000000000001','core_allocated',1,'erased','private','p1','2026-09-05T12:00:00.000Z',?)
`).run("0".repeat(64));
console.log("TERMINAL_CLAIM_PASS");

function expectRejected(label: string, run: () => void, expectedMessage?: string): void {
  let rejection: unknown;
  db.exec("SAVEPOINT negative_case");
  try {
    run();
    db.exec("RELEASE negative_case"); // Also checks deferred FKs.
  } catch (error) {
    rejection = error;
    db.exec("ROLLBACK TO negative_case");
    db.exec("RELEASE negative_case");
  }
  if (rejection === undefined) throw new Error(`${label} was accepted`);
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  if (expectedMessage !== undefined && !message.includes(expectedMessage)) {
    throw new Error(`${label} failed for the wrong reason: ${message}`);
  }
  if (label.includes("MISMATCH") && !message.includes("FOREIGN KEY constraint failed") &&
      !(label === "WIRE_PRINCIPAL_TARGET_MISMATCH" &&
        message.includes("CHECK constraint failed: target_principal_id=principal_id"))) {
    throw new Error(`${label} failed for the wrong reason: ${message}`);
  }
  if ((label.startsWith("CLAIM_REQUIRED_NULL_") || label.startsWith("CANON_REQUIRED_NULL_") ||
       label.startsWith("CLAIM_") || label.startsWith("CANON_")) &&
      !label.endsWith("_IMMUTABLE") && !message.includes("CHECK constraint failed") &&
      !message.includes("cannot store REAL value")) {
    throw new Error(`${label} failed for the wrong reason: ${message}`);
  }
  console.log(`${label}_REJECTED`);
}
expectRejected("CORE_COMMIT_ID_ORIGIN_IMMUTABLE", () => {
  db.exec("UPDATE core_authority_commits SET id_origin='imported_unverified' WHERE admission_seq=1");
}, "identifier origin is immutable");

// Same evidence root may carry distinct checked assessments. SQL enforces the
// keys/columns here; the closed preimages and assessment clamping remain writer
// and restore obligations, not something '{}' below purports to validate.
const sharedSupportKey = "a".repeat(64), reportedAdmissionKey = "b".repeat(64);
db.query(`INSERT INTO claim_v2_support(
  support_id,claim_id,codec,support_key,admission_key,admission_seq,admitted_at,
  effect_ordinal,epistemic_kind,authority,confidence,sensitivity,payload,rendering
) VALUES ('assessment-reported','c1','kizuki.claim-admission/v1',?,?,1,
  '2026-09-05T12:00:00.000Z',1,'reported','connector_evidence',0.9,'private','{}','reported'),
  ('assessment-inferred','c1','kizuki.claim-admission/v1',?,?,1,
  '2026-09-05T12:00:00.000Z',2,'model_inference','model_inference',0.6,'private','{}','inferred')`)
  .run(sharedSupportKey, reportedAdmissionKey, sharedSupportKey, "c".repeat(64));
const assessmentRoots = db.query<{ admissions: number; roots: number; assessments: number }, [string]>(
  `SELECT count(*) AS admissions, count(DISTINCT support_key) AS roots,
    count(DISTINCT epistemic_kind) AS assessments FROM claim_v2_support WHERE support_key=?`,
).get(sharedSupportKey)!;
if (assessmentRoots.admissions !== 2 || assessmentRoots.roots !== 1 || assessmentRoots.assessments !== 2) {
  throw new Error("different assessments did not preserve one shared support root");
}
console.log("DISTINCT_ASSESSMENTS_SHARE_ONE_SUPPORT_ROOT_PASS");
expectRejected("DUPLICATE_ADMISSION_KEY", () => {
  db.query(`INSERT INTO claim_v2_support(
    support_id,claim_id,codec,support_key,admission_key,admission_seq,admitted_at,
    effect_ordinal,epistemic_kind,authority,confidence,sensitivity,payload,rendering
  ) VALUES ('assessment-duplicate','c1','kizuki.claim-admission/v1',?,?,2,
    '2026-09-05T12:00:00.000Z',1,'reported','connector_evidence',0.1,'private','{}','new prose')`)
    .run(sharedSupportKey, reportedAdmissionKey);
}, "UNIQUE constraint failed: claim_v2_support.admission_key");

expectRejected("NULL_TERMINAL_INTEGRITY", () => {
  db.exec(`INSERT INTO claims_v4(
    claim_id,id_origin,id_allocator_version,row_state,sensitivity,purge_receipt_id,erased_at
  ) VALUES ('00000000000000000000000002','core_allocated',1,'erased','private','p1','2026-09-05T12:00:00.000Z')`);
});
expectRejected("NULL_TERMINAL_SENSITIVITY", () => {
  db.query(`INSERT INTO claims_v4(
    claim_id,id_origin,id_allocator_version,row_state,purge_receipt_id,erased_at,tombstone_integrity
  ) VALUES ('00000000000000000000000003','core_allocated',1,'erased','p1','2026-09-05T12:00:00.000Z',?)`).run("0".repeat(64));
});
expectRejected("ERASED_CLAIM_UNVERIFIED_ORIGIN", () => {
  db.query(`INSERT INTO claims_v4(
    claim_id,id_origin,id_allocator_version,row_state,sensitivity,purge_receipt_id,erased_at,tombstone_integrity
  ) VALUES ('00000000000000000000000004','legacy_unverified',NULL,'erased','private','p1',
    '2026-09-05T12:00:00.000Z',?)`).run("0".repeat(64));
}, "CHECK constraint failed");
db.exec(`INSERT INTO claims_v4(
  claim_id,id_origin,id_allocator_version,row_state,record_codec,kind,body,frontmatter,provenance,subjects,
  producer,confidence,status,created_at,body_hash,polarity,authority,sensitivity,
  taint,asserted_at,corroboration
) VALUES ('v2-unknown','legacy_unverified',NULL,'retained','kizuki.claim/v2','claim','','{}','[]','[]',
  'deterministic',1,'live','2026-09-05T12:00:00.000Z',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'positive','owner_authored','private','clean','2026-09-05T12:00:00.000Z',1)`);
console.log("V2_UNKNOWN_VALIDITY_PASS");
for (const [label, assignment] of [
  ["BODY_NONEMPTY", "body='rendered'"],
  ["BODY_HASH_NONEMPTY", `body_hash='${"0".repeat(64)}'`],
  ["FRONTMATTER_NONEMPTY", `frontmatter='{"title":"x"}'`],
] as const) {
  expectRejected(`V2_COMMON_${label}`, () => db.exec(
    `UPDATE claims_v4 SET ${assignment} WHERE claim_id='v2-unknown'`,
  ), "CHECK constraint failed");
}

db.exec("INSERT INTO claims(claim_id) VALUES ('time-offset'),('time-coarse-bad'),('time-fraction')");
db.exec(`INSERT INTO claim_v2_semantics(
  claim_id,codec,semantic_key,valid_kind,valid_from,valid_from_second,
  valid_until,valid_until_second,payload
) VALUES ('time-offset','kizuki.claim-meaning/v1',lower(hex(randomblob(32))),
  'known','2026-01-01T00:00:00+01:00',1767222000,
  '2025-12-31T23:30:00Z',1767223800,'{}')`);
console.log("OFFSET_COARSE_TIME_PASS");
expectRejected("COARSE_TIME_REVERSED", () => {
  db.exec(`INSERT INTO claim_v2_semantics(
    claim_id,codec,semantic_key,valid_kind,valid_from,valid_from_second,
    valid_until,valid_until_second,payload
  ) VALUES ('time-coarse-bad','kizuki.claim-meaning/v1',lower(hex(randomblob(32))),
    'known','2026-01-01T00:00:00Z',1767225600,
    '2025-12-31T23:59:59Z',1767225599,'{}')`);
});
db.exec(`INSERT INTO claim_v2_semantics(
  claim_id,codec,semantic_key,valid_kind,valid_from,valid_from_second,
  valid_until,valid_until_second,payload
) VALUES ('time-fraction','kizuki.claim-meaning/v1',lower(hex(randomblob(32))),
  'known','2026-01-01T00:00:00.9Z',1767225600,
  '2026-01-01T00:00:00.10Z',1767225600,'{}')`);
if (!("2026-01-01T00:00:00.9Z" > "2026-01-01T00:00:00.10Z")) {
  throw new Error("fraction fixture no longer demonstrates exact-order rejection");
}
db.exec("DELETE FROM claim_v2_semantics WHERE claim_id='time-fraction'");
console.log("FRACTION_EXACT_RUNTIME_PREDICATE_REQUIRED_PASS");

function insertRetainedClaim(
  claimId: string,
  overrides: Record<string, string | number | null> = {},
): void {
  const row = {
    id_origin: "legacy_unverified",
    id_allocator_version: null,
    kind: "claim",
    target: claimId,
    body: "retained",
    frontmatter: "{}",
    provenance: '["00000000000000000000061001"]',
    subjects: "[]",
    producer: "deterministic",
    confidence: 1,
    status: "live",
    created_at: "2026-09-05T12:00:00.000Z",
    body_hash: "0".repeat(64),
    subject: null,
    predicate: null,
    object: null,
    polarity: "positive",
    claim_key: null,
    authority: "owner_authored",
    sensitivity: "private",
    taint: "clean",
    model_ref: null,
    valid_from: "2026-09-05T12:00:00Z",
    valid_from_second: 1_757_073_600,
    valid_to: null,
    valid_to_second: null,
    asserted_at: "2026-09-05T12:00:00Z",
    retracted_at: null,
    superseded_by: null,
    receipt_id: null,
    corroboration: 1,
    last_confirmed_at: null,
    ...overrides,
  } satisfies Record<string, string | number | null>;
  db.query(`INSERT INTO claims_v4(
    claim_id,id_origin,id_allocator_version,row_state,record_codec,kind,target,body,frontmatter,provenance,
    subjects,producer,confidence,status,created_at,body_hash,subject,predicate,
    object,polarity,claim_key,authority,sensitivity,taint,model_ref,valid_from,
    valid_from_second,valid_to,valid_to_second,asserted_at,retracted_at,
    superseded_by,receipt_id,corroboration,
    last_confirmed_at
  ) VALUES (?,?,?,'retained','kizuki.claim/v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      claimId, row.id_origin, row.id_allocator_version, row.kind, row.target, row.body, row.frontmatter, row.provenance,
      row.subjects, row.producer, row.confidence, row.status, row.created_at,
      row.body_hash, row.subject, row.predicate, row.object, row.polarity,
      row.claim_key, row.authority, row.sensitivity, row.taint, row.model_ref,
      row.valid_from, row.valid_from_second, row.valid_to, row.valid_to_second,
      row.asserted_at, row.retracted_at,
      row.superseded_by, row.receipt_id, row.corroboration,
      row.last_confirmed_at,
    );
}

insertRetainedClaim("retained-baseline", { status: "provenance_reduced" });
console.log("RETAINED_CLAIM_BASELINE_PASS");
expectRejected("V1_NULL_VALID_FROM", () => {
  db.exec("UPDATE claims_v4 SET valid_from=NULL WHERE claim_id='retained-baseline'");
}, "CHECK constraint failed");
insertRetainedClaim("00000000000000000000006006", {
  id_origin: "core_allocated", id_allocator_version: 1,
});
console.log("RETAINED_CORE_CLAIM_STRUCTURAL_PASS");

expectRejected("RETAINED_CORE_CLAIM_NEEDS_VERSION", () => {
  insertRetainedClaim("00000000000000000000006007", {
    id_origin: "core_allocated", id_allocator_version: null,
  });
}, "CHECK constraint failed");
expectRejected("RETAINED_CORE_CLAIM_NEEDS_CANONICAL_ULID", () => {
  insertRetainedClaim("not-a-core-ulid", {
    id_origin: "core_allocated", id_allocator_version: 1,
  });
}, "CHECK constraint failed");
expectRejected("CLAIM_ID_ORIGIN_IMMUTABLE", () => {
  db.exec("UPDATE claims_v4 SET id_origin='imported_unverified' WHERE claim_id='retained-baseline'");
}, "identifier origin is immutable");
for (const [label, override] of [
  ["CLAIM_KIND_ENUM", { kind: "other" }],
  ["CLAIM_STATUS_ENUM", { status: "purged" }],
  ["CLAIM_POLARITY_ENUM", { polarity: "neutral" }],
  ["CLAIM_AUTHORITY_ENUM", { authority: "owner" }],
  ["CLAIM_SENSITIVITY_ENUM", { sensitivity: "secret" }],
  ["CLAIM_TAINT_ENUM", { taint: "trusted" }],
  ["CLAIM_PRODUCER_ENUM", { producer: "llm" }],
  ["CLAIM_PRODUCER_AGENT_ID", { producer: "agent:/bad" }],
  ["CLAIM_CONFIDENCE_LOW", { confidence: -0.01 }],
  ["CLAIM_CONFIDENCE_HIGH", { confidence: 1.01 }],
  ["CLAIM_CORROBORATION_ZERO", { corroboration: 0 }],
  ["CLAIM_CORROBORATION_FRACTION", { corroboration: 1.5 }],
  ["CLAIM_CORROBORATION_UNSAFE", { corroboration: 9_007_199_254_740_992 }],
  ["CLAIM_BODY_HASH", { body_hash: "A".repeat(64) }],
  ["CLAIM_KEY_HASH", { claim_key: "short" }],
] as const) {
  expectRejected(label, () => insertRetainedClaim(`bad-${label.toLowerCase()}`, override));
}

function insertRetainedCanon(
  receiptId: string,
  overrides: Record<string, string | number | null> = {},
): void {
  const row = {
    id_origin: "legacy_unverified",
    id_allocator_version: null,
    operation_kind: "write",
    claim_ids: "[]",
    provenance: "[]",
    sensitivity: "private",
    page_path: "p.md",
    kind: "claim",
    before_hash: null,
    after_hash: "0".repeat(64),
    at: "2026-09-05T12:00:00.000Z",
    page_action: "edit",
    archive_path: null,
    writer: "loop",
    producer: "deterministic",
    model_ref: null,
    authority: "owner_authored",
    confidence: 1,
    taint: "clean",
    candidates: "[]",
    superseded: "[]",
    retrieval_ops: "[]",
    reverts: null,
    reverted_by: null,
    ...overrides,
  } satisfies Record<string, string | number | null>;
  db.query(`INSERT INTO canon_receipts_v5(
    receipt_id,id_origin,id_allocator_version,row_state,operation_kind,claim_ids,provenance,sensitivity,
    page_path,kind,before_hash,after_hash,at,page_action,archive_path,writer,
    producer,model_ref,authority,confidence,taint,candidates,superseded,
    retrieval_ops,reverts,reverted_by
  ) VALUES (?,?,?,'retained',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receiptId, row.id_origin, row.id_allocator_version, row.operation_kind, row.claim_ids, row.provenance,
      row.sensitivity, row.page_path, row.kind, row.before_hash, row.after_hash,
      row.at, row.page_action, row.archive_path, row.writer, row.producer,
      row.model_ref, row.authority, row.confidence, row.taint, row.candidates,
      row.superseded, row.retrieval_ops, row.reverts, row.reverted_by,
    );
}

insertRetainedCanon("canon-baseline");
console.log("RETAINED_CANON_BASELINE_PASS");
expectRejected("CANON_ID_ORIGIN_IMMUTABLE", () => {
  db.exec("UPDATE canon_receipts_v5 SET id_origin='imported_unverified' WHERE receipt_id='canon-baseline'");
}, "identifier origin is immutable");
const retainedAfterErasureCanon = {
  receipt_id: "00000000000000000000000040", id_origin: "core_allocated", id_allocator_version: 1,
  row_state: "retained_after_erasure", operation_kind: "purge_rewrite", claim_ids: "[]", provenance: "[]",
  sensitivity: "private", page_path: "canon/sanitized.md", kind: "purge_review", before_hash: null,
  after_hash: "a".repeat(64), at: "2026-09-05T12:00:00.000Z", page_action: "edit", archive_path: null,
  writer: "loop", producer: "deterministic", model_ref: null, authority: "owner_authored", confidence: 1,
  taint: "clean", candidates: null, superseded: null, retrieval_ops: null, reverts: null, reverted_by: null,
  purge_receipt_id: "p1", erased_at: "2026-09-05T12:00:01.000Z", tombstone_integrity: null,
  post_erasure_integrity: "b".repeat(64),
} satisfies Record<string, string | number | null>;
function insertRetainedAfterErasureCanon(
  overrides: Record<string, string | number | null> = {},
): void {
  const row: Record<string, string | number | null> = {...retainedAfterErasureCanon, ...overrides};
  const columns = Object.keys(row);
  db.query(`INSERT INTO canon_receipts_v5(${columns.join(",")})
    VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]!));
}
insertRetainedAfterErasureCanon();
console.log("CANON_RETAINED_AFTER_ERASURE_STRUCTURAL_PASS");
for (const [label, patch] of [
  ["POST_ERASURE_BEFORE_HASH", {receipt_id: "00000000000000000000000041", before_hash: "c".repeat(64)}],
  ["POST_ERASURE_REVERT", {receipt_id: "00000000000000000000000042", operation_kind: "revert"}],
  ["POST_ERASURE_LEGACY_ORIGIN", {receipt_id: "00000000000000000000000043", id_origin: "legacy_unverified", id_allocator_version: null}],
  ["POST_ERASURE_NO_INTEGRITY", {receipt_id: "00000000000000000000000044", post_erasure_integrity: null}],
] as const) {
  expectRejected(`CANON_${label}`, () => insertRetainedAfterErasureCanon(patch), "CHECK constraint failed");
}
expectRejected("NULL_RETAINED_OPERATION_KIND", () => {
  insertRetainedCanon("bad-operation-null", { operation_kind: null });
});
for (const [label, override] of [
  ["CANON_OPERATION_ENUM", { operation_kind: "erase" }],
  ["CANON_KIND_ENUM", { kind: "other" }],
  ["CANON_PAGE_ACTION_ENUM", { page_action: "delete" }],
  ["CANON_WRITER_ENUM", { writer: "owner" }],
  ["CANON_PRODUCER_ENUM", { producer: "llm" }],
  ["CANON_PRODUCER_AGENT_ID", { producer: "agent:/bad" }],
  ["CANON_AUTHORITY_ENUM", { authority: "owner" }],
  ["CANON_SENSITIVITY_ENUM", { sensitivity: "secret" }],
  ["CANON_TAINT_ENUM", { taint: "trusted" }],
  ["CANON_CONFIDENCE_LOW", { confidence: -0.01 }],
  ["CANON_CONFIDENCE_HIGH", { confidence: 1.01 }],
  ["CANON_BEFORE_HASH", { before_hash: "A".repeat(64) }],
  ["CANON_AFTER_HASH", { after_hash: "short" }],
] as const) {
  expectRejected(label, () => insertRetainedCanon(`bad-${label.toLowerCase()}`, override));
}

db.exec(`
  INSERT INTO core_authority_commits(admission_seq,admitted_at,operation_id,id_origin,id_allocator_version)
    VALUES (3,'2026-09-05T12:00:00.000Z','00000000000000000000060003','core_allocated',1);
  INSERT INTO claims(claim_id) VALUES ('c3');
  INSERT INTO events(event_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at,id_origin,id_allocator_version)
    VALUES ('00000000000000000000061001',2,'eh','th','ob','2026-09-05T11:59:00.000Z','core_allocated',1);
  INSERT INTO claim_v2_semantics(
    claim_id,codec,semantic_key,valid_kind,payload
  ) VALUES ('c3','kizuki.claim-meaning/v1',lower(hex(randomblob(32))),'unknown','{}');
  INSERT INTO claim_v2_support(
    support_id,claim_id,codec,support_key,admission_key,admission_seq,admitted_at,effect_ordinal,
    epistemic_kind,authority,confidence,sensitivity,payload,rendering
  ) VALUES ('s3','c3','kizuki.claim-admission/v1',lower(hex(randomblob(32))),lower(hex(randomblob(32))),
    3,'2026-09-05T12:00:00.000Z',0,'observed','owner_authored',1,'private','{}','x');
  INSERT INTO claim_v2_support_events(
    support_id,event_id,event_hash_version,event_hash,text_hash,origin_binding,event_accepted_at
  ) VALUES ('s3','00000000000000000000061001',2,'eh','th','ob','2026-09-05T11:59:00.000Z');
  INSERT INTO claim_observations(
    observation_id,support_id,codec,fidelity,occurred_kind,source_observed_at,payload
  ) VALUES ('o3','s3','kizuki.observation-record/v1','verbatim_text','unknown',NULL,'{}');
  INSERT INTO claim_observation_evidence(
    evidence_id,support_id,observation_id,event_id,event_hash_version,event_hash,
    text_hash,origin_binding,event_accepted_at,evidence_kind,start_utf16,end_utf16
  ) VALUES ('ev3','s3','o3','00000000000000000000061001',2,'eh','th','ob',
    '2026-09-05T11:59:00.000Z','text_span',0,1);
  INSERT INTO claim_observation_evidence(
    evidence_id,support_id,observation_id,event_id,event_hash_version,event_hash,
    text_hash,origin_binding,event_accepted_at,evidence_kind,source_field
  ) VALUES ('ev-meta','s3','o3','00000000000000000000061001',2,'eh','th','ob',
    '2026-09-05T11:59:00.000Z','source_metadata','sender');
  INSERT INTO claim_meaning_endpoints(
    claim_id,endpoint_id,role,value_kind,raw_kind,raw_id
  ) VALUES ('c3',0,'subject','raw','supplied','raw-3');
  INSERT INTO claim_admission_endpoint_support(
    claim_id,support_id,endpoint_id,evidence_id,endpoint_raw_kind,endpoint_raw_id
  ) VALUES ('c3','s3',0,'ev3','supplied','raw-3');
  INSERT INTO semantic_handles(handle_id) VALUES ('0123456789abcdef0123456789abcdef');
`);
console.log("UNKNOWN_SOURCE_TIME_AND_METADATA_EVIDENCE_PASS");
expectRejected("RAW_ENDPOINT_EMPTY_SENTINEL", () => {
  db.exec(`INSERT INTO claim_meaning_endpoints(
    claim_id,endpoint_id,role,value_kind,raw_kind,raw_id
  ) VALUES ('c3',1,'object','raw','','raw-3')`);
});
expectRejected("METADATA_EVIDENCE_WITH_SPAN", () => {
  db.exec(`INSERT INTO claim_observation_evidence(
    evidence_id,support_id,observation_id,event_id,event_hash_version,event_hash,
    text_hash,origin_binding,event_accepted_at,evidence_kind,start_utf16,end_utf16,
    source_field
  ) VALUES ('bad-meta','s3','o3','00000000000000000000061001',2,'eh','th','ob',
    '2026-09-05T11:59:00.000Z','source_metadata',0,1,'sender')`);
});
expectRejected("MISMATCHED_RAW_ENDPOINT_OWNER", () => {
  db.exec(`INSERT INTO claim_admission_endpoint_support(
    claim_id,support_id,endpoint_id,evidence_id,endpoint_raw_kind,endpoint_raw_id
  ) VALUES ('c3','s3',0,'ev-meta','supplied','wrong-raw')`);
});
expectRejected("NULL_RETAINED_CODEC", () => {
  db.query(`INSERT INTO semantic_allocation_receipts(
    allocation_receipt_id,id_origin,id_allocator_version,row_state,operation_kind,raw_kind,raw_id,handle_id,
    owner_claim_id,owner_support_id,owner_endpoint_id,owner_evidence_id,
    admission_seq,allocated_at,sensitivity,integrity
  ) VALUES ('bad-codec','legacy_unverified',NULL,'retained','allocate','supplied','raw-3',
    '0123456789abcdef0123456789abcdef','c3','s3',0,'ev3',3,
    '2026-09-05T12:00:00.000Z','private',?)`).run("0".repeat(64));
});
expectRejected("NULL_ALLOCATION_OPERATION_KIND", () => {
  db.query(`INSERT INTO semantic_allocation_receipts(
    allocation_receipt_id,id_origin,id_allocator_version,row_state,codec,raw_kind,raw_id,handle_id,
    owner_claim_id,owner_support_id,owner_endpoint_id,owner_evidence_id,
    admission_seq,allocated_at,sensitivity,integrity
  ) VALUES ('bad-allocation-operation','legacy_unverified',NULL,'retained','kizuki.semantic-allocation/v1',
    'supplied','raw-3','0123456789abcdef0123456789abcdef',
    'c3','s3',0,'ev3',3,'2026-09-05T12:00:00.000Z','private',?)`).run("0".repeat(64));
});
const coreAllocationId = "00000000000000000000000030";
db.query(`INSERT INTO semantic_allocation_receipts(
  allocation_receipt_id,id_origin,id_allocator_version,row_state,codec,operation_kind,raw_kind,raw_id,handle_id,
  owner_claim_id,owner_support_id,owner_endpoint_id,owner_evidence_id,
  admission_seq,allocated_at,sensitivity,integrity
) VALUES (?,'core_allocated',1,'retained','kizuki.semantic-allocation/v1','allocate',
  'supplied','raw-3','0123456789abcdef0123456789abcdef','c3','s3',0,'ev3',3,
  '2026-09-05T12:00:00.000Z','private',?)`).run(coreAllocationId, "0".repeat(64));
expectRejected("ALLOCATION_ID_ORIGIN_IMMUTABLE", () => {
  db.exec(`UPDATE semantic_allocation_receipts SET id_origin='legacy_unverified',id_allocator_version=NULL
    WHERE allocation_receipt_id='00000000000000000000000030'`);
}, "identifier origin is immutable");
db.query(`INSERT INTO semantic_binding_revalidations(
  revalidation_id,raw_kind,raw_id,handle_id,allocation_receipt_id,
  allocation_receipt_state,owner_claim_id,owner_support_id,owner_endpoint_id,
  owner_evidence_id,admission_seq,revalidated_at,effect_ordinal,reason
) VALUES ('revalidation-1','supplied','raw-3',
  '0123456789abcdef0123456789abcdef',?,'retained','c3','s3',0,
  'ev3',3,'2026-09-05T12:00:00.000Z',1,'initial')`).run(coreAllocationId);
db.query(`INSERT INTO semantic_bindings(
  raw_kind,raw_id,binding_state,handle_id,allocation_receipt_id,
  allocation_receipt_state,current_revalidation_id,owner_claim_id,
  owner_support_id,owner_endpoint_id,owner_evidence_id
) VALUES ('supplied','raw-3','active','0123456789abcdef0123456789abcdef',
  ?,'retained','revalidation-1','c3','s3',0,'ev3')`).run(coreAllocationId);
db.exec(`INSERT INTO core_authority_commits(admission_seq,admitted_at,operation_id,id_origin,id_allocator_version)
  VALUES (4,'2026-09-05T12:00:01.000Z','00000000000000000000060004','core_allocated',1)`);
expectRejected("RETIRE_CURRENT_REVALIDATION", () => {
  db.exec(`INSERT INTO semantic_binding_revalidation_retirements(
    revalidation_id,admission_seq,retired_at,effect_ordinal,cause_kind
  ) VALUES ('revalidation-1',4,'2026-09-05T12:00:01.000Z',0,'correction')`);
});
db.exec("DELETE FROM semantic_bindings WHERE current_revalidation_id='revalidation-1'");
db.exec(`INSERT INTO semantic_binding_revalidation_retirements(
  revalidation_id,admission_seq,retired_at,effect_ordinal,cause_kind
) VALUES ('revalidation-1',4,'2026-09-05T12:00:01.000Z',0,'correction')`);
expectRejected("REUSE_RETIRED_REVALIDATION", () => {
  db.query(`INSERT INTO semantic_bindings(
    raw_kind,raw_id,binding_state,handle_id,allocation_receipt_id,
    allocation_receipt_state,current_revalidation_id,owner_claim_id,
    owner_support_id,owner_endpoint_id,owner_evidence_id
  ) VALUES ('supplied','raw-3','active','0123456789abcdef0123456789abcdef',
    ?,'retained','revalidation-1','c3','s3',0,'ev3')`).run(coreAllocationId);
});
expectRejected("MUTATE_HISTORICAL_REVALIDATION", () => {
  db.exec("UPDATE semantic_binding_revalidations SET reason='initial' WHERE revalidation_id='revalidation-1'");
});
const retainedRevalidation = db.query<{ count: number }, []>(
  "SELECT count(*) AS count FROM semantic_binding_revalidations WHERE revalidation_id='revalidation-1'",
).get()!.count;
if (retainedRevalidation !== 1) throw new Error("ordinary retirement deleted revalidation history");
console.log("ORDINARY_REVALIDATION_RETIREMENT_PASS");

db.exec("DELETE FROM semantic_binding_revalidation_retirements WHERE revalidation_id='revalidation-1'");
db.exec("DELETE FROM semantic_binding_revalidations WHERE revalidation_id='revalidation-1'");
db.query(`UPDATE semantic_allocation_receipts SET
  row_state='erased',codec=NULL,operation_kind=NULL,raw_kind=NULL,raw_id=NULL,
  handle_id=NULL,owner_claim_id=NULL,owner_support_id=NULL,owner_endpoint_id=NULL,
  owner_evidence_id=NULL,admission_seq=NULL,allocated_at=NULL,sensitivity='private',
  purge_receipt_id='p1',erased_at='2026-09-05T12:00:02.000Z',integrity=?
  WHERE allocation_receipt_id=?`).run("1".repeat(64), coreAllocationId);
db.exec(`INSERT INTO core_authority_commits(admission_seq,admitted_at,operation_id,id_origin,id_allocator_version)
  VALUES (5,'2026-09-05T12:00:02.000Z','00000000000000000000060005','core_allocated',1)`);
expectRejected("SURVIVOR_REVALIDATION_PURGE_MISMATCH", () => {
  db.query(`INSERT INTO semantic_binding_revalidations(
    revalidation_id,raw_kind,raw_id,handle_id,allocation_receipt_id,
    allocation_receipt_state,owner_claim_id,owner_support_id,owner_endpoint_id,
    owner_evidence_id,admission_seq,revalidated_at,effect_ordinal,reason,purge_receipt_id
  ) VALUES ('revalidation-bad-purge','supplied','raw-3',
    '0123456789abcdef0123456789abcdef',?,'erased','c3','s3',0,
    'ev3',5,'2026-09-05T12:00:02.000Z',0,'independent_survivor','p2')`).run(coreAllocationId);
});
db.query(`INSERT INTO semantic_binding_revalidations(
  revalidation_id,raw_kind,raw_id,handle_id,allocation_receipt_id,
  allocation_receipt_state,owner_claim_id,owner_support_id,owner_endpoint_id,
  owner_evidence_id,admission_seq,revalidated_at,effect_ordinal,reason,purge_receipt_id
) VALUES ('revalidation-2','supplied','raw-3',
  '0123456789abcdef0123456789abcdef',?,'erased','c3','s3',0,
  'ev3',5,'2026-09-05T12:00:02.000Z',0,'independent_survivor','p1')`).run(coreAllocationId);
db.query(`INSERT INTO semantic_bindings(
  raw_kind,raw_id,binding_state,handle_id,allocation_receipt_id,
  allocation_receipt_state,current_revalidation_id,owner_claim_id,
  owner_support_id,owner_endpoint_id,owner_evidence_id
) VALUES ('supplied','raw-3','active','0123456789abcdef0123456789abcdef',
  ?,'erased','revalidation-2','c3','s3',0,'ev3')`).run(coreAllocationId);
console.log("INDEPENDENT_SURVIVOR_PURGE_BINDING_PASS");

db.exec(`INSERT INTO world_authorization_namespaces(
  namespace_id,principal_id,purpose_policy,normalized_scope,sensitivity_ceiling,
  wire_schema,namespace_generation,state
) VALUES ('namespace-000001','principal-1','{"tools":["query_claims","correct"],"sourceUseMapping":"v1"}',
  '{}','private','world/v1',1,'current')`);
expectRejected("SECOND_CURRENT_NAMESPACE", () => {
  db.exec(`INSERT INTO world_authorization_namespaces(
    namespace_id,principal_id,purpose_policy,normalized_scope,sensitivity_ceiling,
    wire_schema,namespace_generation,state
  ) VALUES ('namespace-000002','principal-1','{"tools":["query_claims"],"sourceUseMapping":"v1"}',
    '{}','private','world/v1',2,'current')`);
});
db.exec(`INSERT INTO world_view_partitions(partition_id,principal_id,reserved_at)
  VALUES (0,'principal-2','2026-09-05T12:00:00.000Z')`);
expectRejected("SNAPSHOT_NAMESPACE_PRINCIPAL_MISMATCH", () => {
  db.query(`INSERT INTO world_scoped_tokens(
    token_key_hash,token_kind,runtime_generation,partition_id,
    principal_id,namespace_id,subject_scope_codec,normalized_subject_scope,
    valid_kind,snapshot_seq,snapshot_at,created_at,expires_at
  ) VALUES (?,'snapshot',?,0,'principal-2','namespace-000001',
    'kizuki.subject-scope/v1','{}','all',1,'2026-09-05T12:00:00.000Z',
    '2026-09-05T12:00:00.000Z','2026-09-05T12:15:00.000Z')`)
    .run("1".repeat(64), "2".repeat(32));
});
db.exec(`INSERT INTO world_view_partitions(partition_id,principal_id,reserved_at)
  VALUES (1,'principal-1','2026-09-05T12:00:00.000Z')`);
function insertValidityToken(
  label: string, validKind: string, validAt: string | null = null,
  validFrom: string | null = null, validUntil: string | null = null,
): void {
  db.query(`INSERT INTO world_scoped_tokens(
    token_key_hash,token_kind,runtime_generation,partition_id,principal_id,
    namespace_id,subject_scope_codec,normalized_subject_scope,valid_kind,
    valid_at,valid_from,valid_until,snapshot_seq,snapshot_at,created_at,expires_at
  ) VALUES (?,'snapshot',?,1,'principal-1','namespace-000001',
    'kizuki.subject-scope/v1','{}',?,?,?,?,1,'2026-09-05T12:00:00.000Z',
    '2026-09-05T12:00:00.000Z','2026-09-05T12:15:00.000Z')`)
    .run(createHash("sha256").update(label).digest("hex"), "2".repeat(32),
      validKind, validAt, validFrom, validUntil);
}
insertValidityToken("valid-all", "all");
insertValidityToken("valid-at", "at", "2026-01-01T00:00:00.123456+01:00");
insertValidityToken("valid-overlap", "overlap", null,
  "2026-01-01T00:00:00+01:00", "2025-12-31T23:30:00Z");
insertValidityToken("valid-unknown-only", "unknown_only");
const validityArms = db.query<{ valid_kind: string; valid_at: string | null; valid_from: string | null; valid_until: string | null }, []>(
  "SELECT valid_kind,valid_at,valid_from,valid_until FROM world_scoped_tokens ORDER BY valid_kind",
).all();
if (validityArms.map(item => item.valid_kind).join(",") !== "all,at,overlap,unknown_only") {
  throw new Error("the four ValidQuery arms did not persist distinctly");
}
const point = validityArms.find(item => item.valid_kind === "at")!;
if (point.valid_at !== "2026-01-01T00:00:00.123456+01:00" || point.valid_from !== null || point.valid_until !== null) {
  throw new Error("point validity was converted into an interval");
}
console.log("VALID_QUERY_FOUR_DISTINCT_ARMS_AND_EXACT_POINT_BYTES_PASS");
for (const [label, kind, instant, from, until] of [
  ["OLD_KNOWN", "known", null, null, null],
  ["OLD_UNKNOWN", "unknown", null, null, null],
  ["ALL_WITH_POINT", "all", "2026-01-01T00:00:00Z", null, null],
  ["AT_WITHOUT_POINT", "at", null, null, null],
  ["AT_WITH_INTERVAL", "at", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", null],
  ["OVERLAP_WITHOUT_END", "overlap", null, "2026-01-01T00:00:00Z", null],
  ["OVERLAP_WITH_POINT", "overlap", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
  ["UNKNOWN_ONLY_WITH_INTERVAL", "unknown_only", null, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
] as const) {
  expectRejected(`VALID_QUERY_${label}`, () => insertValidityToken(label, kind, instant, from, until), "CHECK constraint failed");
}
console.log("VALID_QUERY_RFC3339_ORDERING_REMAINS_WRITER_RESTORE_VALIDATION");
db.query(`INSERT INTO world_wire_refs(
  namespace_id,principal_id,wire_ref,ref_kind,issued_at
) VALUES ('namespace-000001','principal-1',?,'claim',
  '2026-09-05T12:00:00.000Z')`).run("A".repeat(43));
expectRejected("WIRE_TARGET_KIND_MISMATCH", () => {
  db.query(`INSERT INTO world_wire_object_targets(
    namespace_id,principal_id,wire_ref,ref_kind,handle_id
  ) VALUES ('namespace-000001','principal-1',?,'object',
    '0123456789abcdef0123456789abcdef')`).run("A".repeat(43));
});
db.query("DELETE FROM world_wire_refs WHERE wire_ref=?").run("A".repeat(43));

function insertWire(seed: string, refKind: string, principalId = "principal-1"): string {
  const wireRef = `${seed.repeat(42)}A`;
  db.query(`INSERT INTO world_wire_refs(
    namespace_id,principal_id,wire_ref,ref_kind,issued_at
  ) VALUES ('namespace-000001',?,?,?,'2026-09-05T12:00:00.000Z')`)
    .run(principalId, wireRef, refKind);
  return wireRef;
}

expectRejected("WIRE_NONCANONICAL_32_BYTE_ENCODING", () => {
  db.query(`INSERT INTO world_wire_refs(
    namespace_id,principal_id,wire_ref,ref_kind,issued_at
  ) VALUES ('namespace-000001','principal-1',?,'claim',
    '2026-09-05T12:00:00.000Z')`).run("B".repeat(43));
});
for (const oldKind of ["evidence", "event", "transition", "canon_receipt"] as const) {
  expectRejected(`WIRE_OLD_KIND_${oldKind.toUpperCase()}`, () => {
    insertWire("Z", oldKind);
  });
}
expectRejected("WIRE_COMMON_PRINCIPAL_MISMATCH", () => {
  insertWire("Y", "claim", "principal-2");
});

db.exec(`
  INSERT INTO source_grants(source_key) VALUES ('source-1');
  INSERT INTO source_event_bindings(event_id,source_key,grant_revision,policy_digest)
    VALUES ('00000000000000000000061001','source-1',1,'policy-1');
  INSERT INTO page_index(page_id) VALUES ('page-1');
  INSERT INTO canon_receipts(receipt_id) VALUES ('canon-1');
  INSERT INTO claim_occurrences(
    occurrence_id,event_id,event_hash_version,event_hash,text_hash,origin_binding,
    event_accepted_at,source_key,grant_revision,policy_digest,start_utf16,end_utf16,
    label,payload
  ) VALUES (
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '00000000000000000000061001',2,'eh','th','ob','2026-09-05T11:59:00.000Z','source-1',1,'policy-1',
    0,1,'x','{}');
`);

const objectRef = insertWire("B", "object");
db.query(`INSERT INTO world_wire_object_targets(
  namespace_id,principal_id,wire_ref,ref_kind,handle_id
) VALUES ('namespace-000001','principal-1',?,'object',
  '0123456789abcdef0123456789abcdef')`).run(objectRef);

const claimRef = insertWire("C", "claim");
db.query(`INSERT INTO world_wire_claim_targets(
  namespace_id,principal_id,wire_ref,ref_kind,claim_id
) VALUES ('namespace-000001','principal-1',?,'claim','c3')`).run(claimRef);

const admissionRef = insertWire("D", "admission");
db.query(`INSERT INTO world_wire_admission_targets(
  namespace_id,principal_id,wire_ref,ref_kind,claim_id,support_id
) VALUES ('namespace-000001','principal-1',?,'admission','c3','s3')`).run(admissionRef);

const observationRef = insertWire("E", "observation");
db.query(`INSERT INTO world_wire_observation_targets(
  namespace_id,principal_id,wire_ref,ref_kind,support_id,observation_id
) VALUES ('namespace-000001','principal-1',?,'observation','s3','o3')`).run(observationRef);

const eventRef = insertWire("F", "event_version");
db.query(`INSERT INTO world_wire_event_version_targets(
  namespace_id,principal_id,wire_ref,ref_kind,event_id,event_hash_version,
  event_hash,text_hash,origin_binding,event_accepted_at
) VALUES ('namespace-000001','principal-1',?,'event_version','00000000000000000000061001',2,'eh','th','ob',
  '2026-09-05T11:59:00.000Z')`).run(eventRef);

for (const [seed, variant, receiptId, table] of [
  ["G", "canon", "canon-1", "world_wire_canon_receipt_targets"],
  ["H", "allocation", coreAllocationId, "world_wire_allocation_receipt_targets"],
  ["I", "purge", "p1", "world_wire_purge_receipt_targets"],
] as const) {
  const receiptRef = insertWire(seed, "receipt");
  db.query(`INSERT INTO world_wire_receipt_targets(
    namespace_id,principal_id,wire_ref,ref_kind,receipt_variant,receipt_id
  ) VALUES ('namespace-000001','principal-1',?,'receipt',?,?)`)
    .run(receiptRef, variant, receiptId);
  db.query(`INSERT INTO ${table}(
    namespace_id,principal_id,wire_ref,ref_kind,receipt_variant,receipt_id
  ) VALUES ('namespace-000001','principal-1',?,'receipt',?,?)`)
    .run(receiptRef, variant, receiptId);
}

const sourceRef = insertWire("J", "source");
db.query(`INSERT INTO world_wire_source_targets(
  namespace_id,principal_id,wire_ref,ref_kind,source_key
) VALUES ('namespace-000001','principal-1',?,'source','source-1')`).run(sourceRef);

const pageRef = insertWire("K", "page");
db.query(`INSERT INTO world_wire_page_targets(
  namespace_id,principal_id,wire_ref,ref_kind,page_id
) VALUES ('namespace-000001','principal-1',?,'page','page-1')`).run(pageRef);

const capturedOccurrenceRef = insertWire("L", "captured_subject");
db.query(`INSERT INTO world_wire_captured_subject_targets(
  namespace_id,principal_id,wire_ref,ref_kind,raw_kind,raw_id,occurrence_id
) VALUES ('namespace-000001','principal-1',?,'captured_subject','occurrence',?,?)`)
  .run(capturedOccurrenceRef, "a".repeat(64), "a".repeat(64));

const capturedSuppliedRef = insertWire("M", "captured_subject");
db.query(`INSERT INTO world_wire_captured_subject_targets(
  namespace_id,principal_id,wire_ref,ref_kind,raw_kind,raw_id,
  supplied_event_id,supplied_event_hash_version,supplied_event_hash,
  supplied_text_hash,supplied_origin_binding,supplied_event_accepted_at,
  source_key,grant_revision,policy_digest
) VALUES ('namespace-000001','principal-1',?,'captured_subject','supplied','raw-3',
  '00000000000000000000061001',2,'eh','th','ob','2026-09-05T11:59:00.000Z','source-1',1,'policy-1')`)
  .run(capturedSuppliedRef);
console.log("CAPTURED_SUPPLIED_RUNTIME_MEMBERSHIP_REQUIRED");

// A raw subject has one stable target and exact event memberships. These are
// relational deletion checks, not a managed purge or supplied-subject codec run.
const rawOccurrenceRef = insertWire("a", "raw_subject");
const rawSuppliedRef = insertWire("b", "raw_subject");
db.query(`INSERT INTO world_wire_raw_subject_targets(
  namespace_id,principal_id,wire_ref,ref_kind,raw_kind,raw_id,occurrence_id
) VALUES ('namespace-000001','principal-1',?,'raw_subject','occurrence',?,?),
  ('namespace-000001','principal-1',?,'raw_subject','supplied','raw-shared',NULL)`)
  .run(rawOccurrenceRef, "a".repeat(64), "a".repeat(64), rawSuppliedRef);
db.exec(`INSERT INTO events(
  event_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at,id_origin,id_allocator_version
) VALUES
  ('00000000000000000000061002',2,'raw-eh-A','raw-th-A','raw-ob-A','2026-09-05T11:57:00.000Z','core_allocated',1),
  ('00000000000000000000061003',2,'raw-eh-B','raw-th-B','raw-ob-B','2026-09-05T11:58:00.000Z','core_allocated',1);
  INSERT INTO source_event_bindings VALUES
  ('00000000000000000000061002','source-1',1,'policy-1'),('00000000000000000000061003','source-1',1,'policy-1')`);
type RawMembership = {
  principal: string; ref: string; kind: string; rawId: string;
  occurrenceId: string | null; eventId: string; eventHash: string;
  textHash: string; origin: string; acceptedAt: string;
  sourceKey: string | null; revision: number | null; policy: string | null;
};
const occurrenceMembership: RawMembership = {
  principal: "principal-1", ref: rawOccurrenceRef, kind: "occurrence", rawId: "a".repeat(64),
  occurrenceId: "a".repeat(64), eventId: "00000000000000000000061001", eventHash: "eh", textHash: "th",
  origin: "ob", acceptedAt: "2026-09-05T11:59:00.000Z",
  sourceKey: "source-1", revision: 1, policy: "policy-1",
};
const rawAMembership: RawMembership = {
  ...occurrenceMembership, ref: rawSuppliedRef, kind: "supplied", rawId: "raw-shared",
  occurrenceId: null, eventId: "00000000000000000000061002", eventHash: "raw-eh-A", textHash: "raw-th-A",
  origin: "raw-ob-A", acceptedAt: "2026-09-05T11:57:00.000Z",
};
const rawBMembership: RawMembership = {
  ...rawAMembership, eventId: "00000000000000000000061003", eventHash: "raw-eh-B", textHash: "raw-th-B",
  origin: "raw-ob-B", acceptedAt: "2026-09-05T11:58:00.000Z",
};
function insertRawMembership(value: RawMembership): void {
  db.query(`INSERT INTO world_wire_raw_subject_memberships(
    namespace_id,principal_id,wire_ref,raw_kind,raw_id,occurrence_id,
    event_id,event_hash_version,event_hash,text_hash,origin_binding,event_accepted_at,
    source_key,grant_revision,policy_digest
  ) VALUES ('namespace-000001',?,?,?,?,?,?,2,?,?,?,?,?,?,?)`)
    .run(value.principal,value.ref,value.kind,value.rawId,value.occurrenceId,value.eventId,
      value.eventHash,value.textHash,value.origin,value.acceptedAt,
      value.sourceKey,value.revision,value.policy);
}
insertRawMembership(occurrenceMembership);
insertRawMembership(rawAMembership);
insertRawMembership(rawBMembership);
if (db.query<{ count: number }, [string]>(
  "SELECT count(*) AS count FROM world_wire_raw_subject_memberships WHERE wire_ref=?",
).get(rawSuppliedRef)!.count !== 2) throw new Error("shared raw target did not retain A and B memberships");
console.log("RAW_SUBJECT_OCCURRENCE_AND_SHARED_SUPPLIED_MEMBERSHIPS_PASS");
for (const [label, baseline, overrides, expected] of [
  ["PRINCIPAL_MISMATCH", rawAMembership, {principal: "principal-2"}, "FOREIGN KEY constraint failed"],
  ["RAW_TARGET_MISMATCH", rawAMembership, {rawId: "another-raw"}, "FOREIGN KEY constraint failed"],
  ["EVENT_HASH_MISMATCH", rawAMembership, {eventHash: "wrong"}, "FOREIGN KEY constraint failed"],
  ["SOURCE_REVISION_MISMATCH", rawAMembership, {revision: 2}, "FOREIGN KEY constraint failed"],
  ["OCCURRENCE_EVENT_MISMATCH", occurrenceMembership,
    {eventId: rawAMembership.eventId,eventHash: rawAMembership.eventHash,
      textHash: rawAMembership.textHash,origin: rawAMembership.origin,
      acceptedAt: rawAMembership.acceptedAt}, "FOREIGN KEY constraint failed"],
  ["OCCURRENCE_NULL", occurrenceMembership, {occurrenceId: null}, "CHECK constraint failed"],
  ["SUPPLIED_HAS_OCCURRENCE", rawAMembership, {occurrenceId: "a".repeat(64)}, "CHECK constraint failed"],
  ["PARTIAL_SOURCE_TUPLE", rawAMembership, {policy: null}, "CHECK constraint failed"],
] as const) {
  expectRejected(`RAW_MEMBERSHIP_${label}`, () => {
    db.query("DELETE FROM world_wire_raw_subject_memberships WHERE wire_ref=? AND event_id=?")
      .run(baseline.ref, baseline.eventId);
    insertRawMembership({...baseline, ...overrides});
  }, expected);
}
expectRejected("RAW_TARGET_NULL_OCCURRENCE", () => {
  const ref = insertWire("c", "raw_subject");
  db.query(`INSERT INTO world_wire_raw_subject_targets VALUES
    ('namespace-000001','principal-1',?,'raw_subject','occurrence','missing',NULL)`)
    .run(ref);
}, "CHECK constraint failed");
expectRejected("RAW_TARGET_DUPLICATE_SUBJECT", () => {
  const ref = insertWire("c", "raw_subject");
  db.query(`INSERT INTO world_wire_raw_subject_targets VALUES
    ('namespace-000001','principal-1',?,'raw_subject','supplied','raw-shared',NULL)`)
    .run(ref);
}, "UNIQUE constraint failed");
const rawSurvivorBefore = db.query<Record<string, string | number | null>, [string]>(
  "SELECT * FROM world_wire_raw_subject_memberships WHERE event_id=?",
).get("00000000000000000000061003");
db.transaction(() => {
  db.exec(`DELETE FROM world_wire_raw_subject_memberships WHERE event_id='00000000000000000000061002';
    DELETE FROM source_event_bindings WHERE event_id='00000000000000000000061002';
    DELETE FROM events WHERE event_id='00000000000000000000061002'`);
})();
const rawSurvivorAfter = db.query<Record<string, string | number | null>, [string]>(
  "SELECT * FROM world_wire_raw_subject_memberships WHERE event_id=?",
).get("00000000000000000000061003");
const retainedRawTargets = db.query<{ count: number }, [string]>(
  `SELECT count(*) AS count FROM world_wire_raw_subject_targets t
    JOIN world_wire_refs w USING(namespace_id,principal_id,wire_ref,ref_kind)
    WHERE t.wire_ref=?`,
).get(rawSuppliedRef)!.count;
if (rawSurvivorBefore === null || JSON.stringify(rawSurvivorBefore) !== JSON.stringify(rawSurvivorAfter) ||
    retainedRawTargets !== 1) throw new Error("removing A changed surviving B or its stable raw-subject map");
console.log("RAW_SUBJECT_REMOVE_A_PRESERVES_EXACT_B_AND_STABLE_MAP_PASS");
db.transaction(() => {
  db.exec(`DELETE FROM world_wire_raw_subject_memberships WHERE event_id='00000000000000000000061003';
    DELETE FROM source_event_bindings WHERE event_id='00000000000000000000061003';
    DELETE FROM events WHERE event_id='00000000000000000000061003'`);
  db.query("DELETE FROM world_wire_raw_subject_targets WHERE wire_ref=?").run(rawSuppliedRef);
  db.query("DELETE FROM world_wire_refs WHERE wire_ref=?").run(rawSuppliedRef);
})();
if (db.query<{ count: number }, [string]>(
  "SELECT count(*) AS count FROM world_wire_refs WHERE wire_ref=?",
).get(rawSuppliedRef)!.count !== 0) throw new Error("last-membership removal left the explicitly removed wire map");
console.log("RAW_SUBJECT_LAST_MEMBERSHIP_AND_MAP_RELATIONAL_REMOVAL_PASS");
console.log("RAW_SUBJECT_CODEC_POLICY_AND_MANAGED_PURGE_REMAIN_IMPLEMENTATION_OBLIGATIONS");

const groupRef = insertWire("N", "claim_group");
db.query(`INSERT INTO world_wire_claim_group_targets(
  namespace_id,principal_id,wire_ref,ref_kind,member_set_hash,member_count
) VALUES ('namespace-000001','principal-1',?,'claim_group',?,2)`)
  .run(groupRef, "4".repeat(64));
db.query(`INSERT INTO world_wire_claim_group_members(
  namespace_id,principal_id,wire_ref,ref_kind,member_count,member_ordinal,claim_id
) VALUES ('namespace-000001','principal-1',?,'claim_group',2,0,'c1'),
         ('namespace-000001','principal-1',?,'claim_group',2,1,'c2')`)
  .run(groupRef, groupRef);

const principalRef = insertWire("O", "principal");
db.query(`INSERT INTO world_wire_principal_targets(
  namespace_id,principal_id,wire_ref,ref_kind,target_principal_id
) VALUES ('namespace-000001','principal-1',?,'principal','principal-1')`).run(principalRef);
console.log("PUBLIC_WIRE_KIND_HAPPY_PATHS_PASS");

expectRejected("WIRE_DUPLICATE_TYPED_TARGET", () => {
  const duplicate = insertWire("P", "claim");
  db.query(`INSERT INTO world_wire_claim_targets(
    namespace_id,principal_id,wire_ref,ref_kind,claim_id
  ) VALUES ('namespace-000001','principal-1',?,'claim','c3')`).run(duplicate);
});
expectRejected("WIRE_TYPED_CHILD_PRINCIPAL_MISMATCH", () => {
  db.exec("DELETE FROM world_wire_source_targets");
  const mismatched = insertWire("Q", "source");
  db.query(`INSERT INTO world_wire_source_targets(
    namespace_id,principal_id,wire_ref,ref_kind,source_key
  ) VALUES ('namespace-000001','principal-2',?,'source','source-1')`).run(mismatched);
});
expectRejected("WIRE_ADMISSION_OWNERSHIP_MISMATCH", () => {
  db.exec("DELETE FROM world_wire_admission_targets");
  const mismatched = insertWire("R", "admission");
  db.query(`INSERT INTO world_wire_admission_targets(
    namespace_id,principal_id,wire_ref,ref_kind,claim_id,support_id
  ) VALUES ('namespace-000001','principal-1',?,'admission','c2','s3')`).run(mismatched);
});
expectRejected("WIRE_OBSERVATION_OWNERSHIP_MISMATCH", () => {
  db.exec("DELETE FROM world_wire_observation_targets");
  const mismatched = insertWire("S", "observation");
  db.query(`INSERT INTO world_wire_observation_targets(
    namespace_id,principal_id,wire_ref,ref_kind,support_id,observation_id
  ) VALUES ('namespace-000001','principal-1',?,'observation','s2','o3')`).run(mismatched);
});
expectRejected("WIRE_EVENT_VERSION_MISMATCH", () => {
  const mismatched = insertWire("T", "event_version");
  db.query(`INSERT INTO world_wire_event_version_targets(
    namespace_id,principal_id,wire_ref,ref_kind,event_id,event_hash_version,
    event_hash,text_hash,origin_binding,event_accepted_at
  ) VALUES ('namespace-000001','principal-1',?,'event_version','00000000000000000000061001',2,'wrong','th',
    'ob','2026-09-05T11:59:00.000Z')`).run(mismatched);
});
expectRejected("WIRE_RECEIPT_VARIANT_MISMATCH", () => {
  db.exec("DELETE FROM world_wire_allocation_receipt_targets");
  db.exec("DELETE FROM world_wire_canon_receipt_targets");
  db.exec("DELETE FROM world_wire_receipt_targets WHERE receipt_variant='canon'");
  const mismatched = insertWire("U", "receipt");
  db.query(`INSERT INTO world_wire_receipt_targets(
    namespace_id,principal_id,wire_ref,ref_kind,receipt_variant,receipt_id
  ) VALUES ('namespace-000001','principal-1',?,'receipt','canon','canon-1')`)
    .run(mismatched);
  db.query(`INSERT INTO world_wire_allocation_receipt_targets(
    namespace_id,principal_id,wire_ref,ref_kind,receipt_variant,receipt_id
  ) VALUES ('namespace-000001','principal-1',?,'receipt','allocation','allocation-1')`)
    .run(mismatched);
});
expectRejected("WIRE_SOURCE_TARGET_MISSING", () => {
  const mismatched = insertWire("V", "source");
  db.query(`INSERT INTO world_wire_source_targets(
    namespace_id,principal_id,wire_ref,ref_kind,source_key
  ) VALUES ('namespace-000001','principal-1',?,'source','missing')`).run(mismatched);
});
expectRejected("WIRE_PAGE_TARGET_MISSING", () => {
  const mismatched = insertWire("W", "page");
  db.query(`INSERT INTO world_wire_page_targets(
    namespace_id,principal_id,wire_ref,ref_kind,page_id
  ) VALUES ('namespace-000001','principal-1',?,'page','missing')`).run(mismatched);
});
expectRejected("WIRE_CAPTURED_OCCURRENCE_MISSING", () => {
  const mismatched = insertWire("X", "captured_subject");
  db.query(`INSERT INTO world_wire_captured_subject_targets(
    namespace_id,principal_id,wire_ref,ref_kind,raw_kind,raw_id,occurrence_id
  ) VALUES ('namespace-000001','principal-1',?,'captured_subject','occurrence',
    'missing','missing')`).run(mismatched);
});
expectRejected("WIRE_CAPTURED_SUPPLIED_EVENT_MISMATCH", () => {
  const mismatched = insertWire("2", "captured_subject");
  db.query(`INSERT INTO world_wire_captured_subject_targets(
    namespace_id,principal_id,wire_ref,ref_kind,raw_kind,raw_id,
    supplied_event_id,supplied_event_hash_version,supplied_event_hash,
    supplied_text_hash,supplied_origin_binding,supplied_event_accepted_at,
    source_key,grant_revision,policy_digest
  ) VALUES ('namespace-000001','principal-1',?,'captured_subject','supplied','raw-3',
    '00000000000000000000061001',2,'wrong','th','ob','2026-09-05T11:59:00.000Z','source-1',1,'policy-1')`)
    .run(mismatched);
});
expectRejected("WIRE_CLAIM_GROUP_MEMBER_MISSING", () => {
  const mismatched = insertWire("0", "claim_group");
  db.query(`INSERT INTO world_wire_claim_group_targets(
    namespace_id,principal_id,wire_ref,ref_kind,member_set_hash,member_count
  ) VALUES ('namespace-000001','principal-1',?,'claim_group',?,2)`)
    .run(mismatched, "5".repeat(64));
  db.query(`INSERT INTO world_wire_claim_group_members(
    namespace_id,principal_id,wire_ref,ref_kind,member_count,member_ordinal,claim_id
  ) VALUES ('namespace-000001','principal-1',?,'claim_group',2,0,'missing')`)
    .run(mismatched);
});
expectRejected("WIRE_PRINCIPAL_TARGET_MISMATCH", () => {
  const mismatched = insertWire("1", "principal");
  db.query(`INSERT INTO world_wire_principal_targets(
    namespace_id,principal_id,wire_ref,ref_kind,target_principal_id
  ) VALUES ('namespace-000001','principal-1',?,'principal','principal-2')`)
    .run(mismatched);
});

console.log(`OBJECT_COUNT=${db.query<{ count: number }, []>(
  "SELECT count(*) AS count FROM sqlite_master WHERE type IN ('table','index','trigger')",
).get()!.count}`);


// Independent additions: production-index reconciliation and NULL-arm coverage.
const claimColumns = db.query<{name:string},[]>("PRAGMA table_info('claims_v4')").all().map(x=>x.name);
const cloneV2 = () => db.query(`INSERT INTO claims_v4 (${claimColumns.join(',')})
 SELECT ${claimColumns.map(x=>x==='claim_id'?"'independent-v2'":x).join(',')}
 FROM claims_v4 WHERE claim_id='v2-unknown'`).run();
db.exec(`CREATE UNIQUE INDEX independent_legacy_retained_idempotency
 ON claims_v4(kind,coalesce(target,''),body_hash)
 WHERE row_state='retained' AND kind<>'purge_review'`);
expectRejected('RECREATED_LEGACY_INDEX_BLOCKS_SECOND_V2_MEANING', cloneV2);
db.exec('DROP INDEX independent_legacy_retained_idempotency');
db.exec(`CREATE UNIQUE INDEX independent_v1_only_idempotency
 ON claims_v4(kind,coalesce(target,''),body_hash)
 WHERE row_state='retained' AND record_codec='kizuki.claim/v1'
 AND kind<>'purge_review'`);
cloneV2();
console.log('V1_ONLY_LEGACY_INDEX_ALLOWS_SECOND_V2_COMMON_ROW_PASS');
expectRejected('V1_ONLY_LEGACY_INDEX_RETAINS_V1_IDEMPOTENCY',()=>insertRetainedClaim('independent-v1-duplicate',{status:'provenance_reduced',target:'retained-baseline'}));
db.exec('DROP INDEX independent_v1_only_idempotency');
for (const field of ['kind','body','frontmatter','provenance','subjects','producer','confidence','status','created_at','body_hash','polarity','authority','sensitivity','taint','valid_from','valid_from_second','asserted_at','corroboration']) {
 expectRejected(`CLAIM_REQUIRED_NULL_${field.toUpperCase()}`,()=>insertRetainedClaim(`independent-null-${field}`,{[field]:null}));
}
for (const field of ['operation_kind','claim_ids','provenance','sensitivity','page_path','kind','after_hash','at','page_action','writer','producer','authority','confidence','taint','candidates','superseded','retrieval_ops']) {
 expectRejected(`CANON_REQUIRED_NULL_${field.toUpperCase()}`,()=>insertRetainedCanon(`independent-null-${field}`,{[field]:null}));
}
// This is a declared codec validation obligation, not a claim of SQL rejection.
db.exec(`INSERT INTO claim_observations(observation_id,support_id,codec,fidelity,occurred_kind,payload)
 VALUES('o3-other','s3','kizuki.observation-record/v1','source_metadata','unknown','{}');
 INSERT INTO claim_observation_attributions(attribution_id,support_id,observation_id,role,raw_kind,raw_id,basis,source_field)
 VALUES('attr-other','s3','o3-other','sender','supplied','raw-3','source_field','sender');
 INSERT INTO claim_observation_attribution_evidence(support_id,attribution_id,evidence_id)
 VALUES('s3','attr-other','ev-meta');`);
console.log('CROSS_OBSERVATION_ATTRIBUTION_ACCEPTED_BY_SQL_REQUIRES_DECLARED_CODEC_REJECTION');

// Purge 6 staged-table structural checks. The authority parents above are stubs;
// '{}' below only exercises SQL object/phase arms, never a checked authority,
// coordinator manifest, absence result, migration, or completion receipt codec.
type PurgeSqlRow = Record<string, string | number | null>;
const purgeId = (value: number): string => value.toString().padStart(26, "0");
const purgeWorkBinding = '{"synthetic":"structural-only"}';
const purgeWorkDigest = "a".repeat(64);
const sourceRootId = purgeId(1), eventRootId = purgeId(2);
const eventChildId = purgeId(3), sourceChildId = purgeId(4);
const sourceCoordinatorId = purgeId(21), eventCoordinatorId = purgeId(22);
const eventWorkId = purgeId(23);
function insertPurgeRow(table: "event_purges_v6" | "purge_ops_v6", row: PurgeSqlRow): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map(column => row[column]!));
}
const sourceRoot: PurgeSqlRow = {
  receipt_id: sourceRootId, id_origin: "core_allocated", id_allocator_version: 1,
  batch_receipt_id: sourceRootId, selection_kind: "source_root",
  event_id: null, event_id_origin: null, event_id_allocator_version: null,
  state: "pending", phase: "work", connector_id: null, reason: "synthetic source revoke",
  source_authority: "{}", created_at: "2026-09-05T12:00:00.000Z", done_at: null,
  sensitivity: "private", terminal_integrity: null,
};
const eventRoot: PurgeSqlRow = {
  ...sourceRoot, receipt_id: eventRootId, batch_receipt_id: eventRootId, selection_kind: "event",
  event_id: purgeId(11), event_id_origin: "core_allocated", event_id_allocator_version: 1,
  connector_id: "synthetic-connector", source_authority: null,
};
const reservationCoordinator: PurgeSqlRow = {
  op_id: sourceCoordinatorId, id_origin: "core_allocated", id_allocator_version: 1,
  receipt_id: sourceRootId, store: "coordinator",
  state: "pending", phase: "work", ids: "[]", proof: null, completion: null,
  work_binding: null, work_revision: 0, work_digest: null,
  created_at: "2026-09-05T12:00:00.000Z", done_at: null, sensitivity: "private",
};
db.transaction(() => {
  insertPurgeRow("event_purges_v6", sourceRoot);
  insertPurgeRow("purge_ops_v6", reservationCoordinator);
})();
const reserved = db.query<{ members: number; coordinators: number; proof: string | null }, [string, string]>(
  `SELECT (SELECT count(*) FROM event_purges_v6 WHERE batch_receipt_id=? AND selection_kind='event') AS members,
    count(*) AS coordinators,proof FROM purge_ops_v6 WHERE receipt_id=? AND store='coordinator'`,
).get(sourceRootId,sourceRootId)!;
if (reserved.members !== 0 || reserved.coordinators !== 1 || reserved.proof !== null) {
  throw new Error("zero-event source reservation was not pending with one unplanned coordinator");
}
console.log("PURGE6_ZERO_EVENT_SOURCE_ROOT_AND_PENDING_COORDINATOR_STRUCTURAL_PASS");
db.transaction(() => {
  insertPurgeRow("event_purges_v6", eventRoot);
  insertPurgeRow("event_purges_v6", {...eventRoot,
    receipt_id: eventChildId, event_id: purgeId(12)});
  insertPurgeRow("event_purges_v6", {...eventRoot,
    receipt_id: sourceChildId, batch_receipt_id: sourceRootId, event_id: purgeId(13)});
  insertPurgeRow("purge_ops_v6", {...reservationCoordinator,
    op_id: eventCoordinatorId, receipt_id: eventRootId, ids: JSON.stringify([purgeId(11),purgeId(12)]),
    work_binding: purgeWorkBinding, work_revision: 1, work_digest: purgeWorkDigest, proof: "{}"});
  insertPurgeRow("purge_ops_v6", {...reservationCoordinator,
    op_id: eventWorkId, receipt_id: eventRootId, store: "ledger_sqlite", ids: JSON.stringify([purgeId(11),purgeId(12)]),
    work_binding: purgeWorkBinding, work_revision: 1, work_digest: purgeWorkDigest});
})();
if (db.query<{ count: number }, [string]>(
  "SELECT count(*) AS count FROM event_purges_v6 WHERE batch_receipt_id=?",
).get(eventRootId)!.count !== 2) throw new Error("event root and child did not retain exact batch membership");
console.log("PURGE6_EVENT_ROOT_CHILD_AND_SOURCE_ROOT_CHILD_STRUCTURAL_PASS");
for (const [label, patch, expected] of [
  ["UNKNOWN_SELECTION", {selection_kind: "unknown"}, "CHECK constraint failed"],
  ["EVENT_WITHOUT_EVENT_ID", {event_id: null}, "CHECK constraint failed"],
  ["EVENT_WITH_SOURCE_AUTHORITY", {source_authority: "{}"}, "CHECK constraint failed"],
  ["EVENT_WORK_WITHOUT_CONNECTOR", {connector_id: null}, "CHECK constraint failed"],
  ["WORK_WITHOUT_REASON", {reason: null}, "CHECK constraint failed"],
  ["WORK_WITHOUT_PHASE", {phase: null}, "CHECK constraint failed"],
  ["PUBLIC_SENSITIVITY", {sensitivity: "public"}, "CHECK constraint failed"],
  ["CORE_RECEIPT_BAD_ULID", {receipt_id: "legacy-receipt"}, "CHECK constraint failed"],
  ["CORE_RECEIPT_MISSING_VERSION", {id_allocator_version: null}, "CHECK constraint failed"],
  ["CORE_EVENT_MISSING_VERSION", {event_id_allocator_version: null}, "CHECK constraint failed"],
  ["MISSING_BATCH_ROOT", {batch_receipt_id: purgeId(999)}, "FOREIGN KEY constraint failed"],
] as const) {
  expectRejected(`PURGE6_${label}`, () => insertPurgeRow("event_purges_v6", {
    ...eventRoot,receipt_id: purgeId(100),event_id: purgeId(101),...patch,
  }), expected);
}
const independentSourceRoot = {
  ...sourceRoot, receipt_id: purgeId(100), batch_receipt_id: purgeId(100),
};
for (const [label, patch] of [
  ["SOURCE_ROOT_NOT_SELF_BATCHED", {batch_receipt_id: sourceRootId}],
  ["SOURCE_ROOT_HAS_EVENT", {event_id: purgeId(101)}],
  ["SOURCE_ROOT_EVENT_ORIGIN", {event_id_origin: "core_allocated"}],
  ["SOURCE_ROOT_EVENT_ORIGIN_VERSION", {event_id_allocator_version: 1}],
  ["SOURCE_ROOT_WITHOUT_AUTHORITY", {source_authority: null}],
  ["SOURCE_ROOT_WITH_CONNECTOR", {connector_id: "synthetic-connector"}],
  ["SOURCE_ROOT_AUTHORITY_ARRAY", {source_authority: "[]"}],
  ["MALFORMED_SOURCE_JSON", {source_authority: "{"}],
] as const) {
  expectRejected(`PURGE6_${label}`, () => insertPurgeRow("event_purges_v6", {
    ...independentSourceRoot,...patch,
  }), "CHECK constraint failed");
}
expectRejected("PURGE6_LEGACY_EVENT_COPIED_ORIGIN_CANNOT_TERMINALIZE", () => {
  insertPurgeRow("event_purges_v6", {
    ...eventRoot, receipt_id: purgeId(100), batch_receipt_id: purgeId(100), event_id: purgeId(101),
    event_id_origin: "legacy_unverified", event_id_allocator_version: null,
    state: "done", phase: null, connector_id: null, reason: null, source_authority: null,
    done_at: "2026-09-05T12:02:00.000Z", terminal_integrity: "d".repeat(64),
  });
}, "CHECK constraint failed");
expectRejected("PURGE6_LEGACY_RECEIPT_CANNOT_TERMINALIZE", () => {
  insertPurgeRow("event_purges_v6", {
    ...eventRoot, receipt_id: purgeId(102), batch_receipt_id: purgeId(102), event_id: purgeId(103),
    id_origin: "legacy_unverified", id_allocator_version: null,
    state: "done", phase: null, connector_id: null, reason: null, source_authority: null,
    done_at: "2026-09-05T12:02:00.000Z", terminal_integrity: "d".repeat(64),
  });
}, "CHECK constraint failed");
expectRejected("PURGE6_DUPLICATE_EVENT_ID", () => insertPurgeRow("event_purges_v6", {
  ...eventRoot,receipt_id: purgeId(100),
}), "UNIQUE constraint failed: event_purges_v6.event_id");
expectRejected("PURGE6_DUPLICATE_COORDINATOR", () => insertPurgeRow("purge_ops_v6", {
  ...reservationCoordinator,op_id: purgeId(100),
}), "UNIQUE constraint failed: purge_ops_v6.receipt_id");
for (const [label, patch, expected] of [
  ["OP_MISSING_RECEIPT", {receipt_id: purgeId(999)}, "FOREIGN KEY constraint failed"],
  ["OP_UNKNOWN_STORE", {store: "captured-filename"}, "CHECK constraint failed"],
  ["OP_IDS_OBJECT", {ids: "{}"}, "CHECK constraint failed"],
  ["OP_PROOF_ARRAY", {proof: "[]"}, "CHECK constraint failed"],
  ["OP_WORK_WITHOUT_IDS", {ids: null}, "CHECK constraint failed"],
  ["OP_WORK_WITHOUT_PHASE", {phase: null}, "CHECK constraint failed"],
  ["OP_CORE_MISSING_VERSION", {id_allocator_version: null}, "CHECK constraint failed"],
  ["OP_WORK_WITHOUT_BINDING", {work_binding: null}, "CHECK constraint failed"],
  ["OP_WORK_ZERO_REVISION", {work_revision: 0}, "CHECK constraint failed"],
  ["OP_WORK_WITHOUT_DIGEST", {work_digest: null}, "CHECK constraint failed"],
  ["OP_WORK_BINDING_ARRAY", {work_binding: "[]"}, "CHECK constraint failed"],
  ["OP_WORK_DIGEST_UPPERCASE", {work_digest: "A".repeat(64)}, "CHECK constraint failed"],
] as const) {
  expectRejected(`PURGE6_${label}`, () => insertPurgeRow("purge_ops_v6", {
    ...reservationCoordinator,op_id: purgeId(100),store: "ledger_sqlite",ids: '["target"]',
    work_binding: purgeWorkBinding,work_revision: 1,work_digest: purgeWorkDigest,...patch,
  }), expected);
}
// Start each maintenance fault from a row accepted by the maintenance arm.
const maintenanceOp: PurgeSqlRow = {
  ...reservationCoordinator, op_id: purgeId(100), store: "ledger_sqlite",
  phase: "maintenance", ids: "[]", proof: "{}",
  work_binding: null, work_revision: null, work_digest: null,
};
db.exec("SAVEPOINT valid_maintenance");
insertPurgeRow("purge_ops_v6", maintenanceOp);
db.exec("ROLLBACK TO valid_maintenance; RELEASE valid_maintenance");
console.log("PURGE6_MAINTENANCE_POSITIVE_BASELINE_STRUCTURAL_PASS");
for (const [label, patch] of [
  ["TARGETS", {ids: '["target"]'}],
  ["NO_PROOF", {proof: null}],
  ["WORK_BINDING", {work_binding: purgeWorkBinding}],
  ["WORK_REVISION", {work_revision: 1}],
  ["WORK_DIGEST", {work_digest: purgeWorkDigest}],
] as const) {
  expectRejected(`PURGE6_OP_MAINTENANCE_${label}`, () => insertPurgeRow("purge_ops_v6", {
    ...maintenanceOp, ...patch,
  }), "CHECK constraint failed");
}
expectRejected("PURGE6_LEGACY_OPERATION_CANNOT_TERMINALIZE", () => {
  insertPurgeRow("purge_ops_v6", {
    ...reservationCoordinator, op_id: purgeId(104), receipt_id: sourceRootId, store: "ledger_sqlite",
    id_origin: "legacy_unverified", id_allocator_version: null,
    state: "done", phase: null, ids: null, work_binding: null, work_revision: null, work_digest: null,
    proof: null, completion: "{}", done_at: "2026-09-05T12:02:00.000Z",
  });
}, "CHECK constraint failed");
db.transaction(() => {
  db.query(`INSERT INTO canon_source_erasure_intents_v5(
    page_path,purge_receipt_id,source_key,intent_revision,write_state,codec,intent,digest
  ) VALUES ('canon/event.md',?,NULL,1,'staged','kizuki.canon-erasure-intent/v2','{}',?),
    ('canon/source.md',?,'source-1',1,'staged','kizuki.canon-erasure-intent/v2','{}',?)`)
    .run(eventRootId, "b".repeat(64), sourceRootId, "c".repeat(64));
})();
const canonIntentRows = db.query<{ eventRows: number; sourceRows: number }, [string, string]>(
  `SELECT sum(source_key IS NULL) AS eventRows, sum(source_key IS NOT NULL) AS sourceRows
   FROM canon_source_erasure_intents_v5 WHERE purge_receipt_id IN (?,?)`,
).get(eventRootId, sourceRootId)!;
if (canonIntentRows.eventRows !== 1 || canonIntentRows.sourceRows !== 1) {
  throw new Error("canon source-erasure intent source-key arms did not persist distinctly");
}
console.log("PURGE6_CANON_INTENT_EVENT_AND_SOURCE_KEY_STRUCTURAL_PASS");
for (const [label, patch, expected] of [
  ["CANON_INTENT_UNKNOWN_PURGE", {purge_receipt_id: purgeId(999)}, "FOREIGN KEY constraint failed"],
  ["CANON_INTENT_UNKNOWN_SOURCE", {source_key: "missing-source"}, "FOREIGN KEY constraint failed"],
  ["CANON_INTENT_CODEC", {codec: "kizuki.canon-erasure-intent/v1"}, "CHECK constraint failed"],
  ["CANON_INTENT_ARRAY", {intent: "[]"}, "CHECK constraint failed"],
  ["CANON_INTENT_DIGEST", {digest: "D".repeat(64)}, "CHECK constraint failed"],
  ["CANON_INTENT_EMPTY_PATH", {page_path: ""}, "CHECK constraint failed"],
  ["CANON_INTENT_ZERO_REVISION", {intent_revision: 0}, "CHECK constraint failed"],
  ["CANON_INTENT_UNSAFE_REVISION", {intent_revision: 9007199254740992}, "CHECK constraint failed"],
  ["CANON_INTENT_UNKNOWN_WRITE_STATE", {write_state: "done"}, "CHECK constraint failed"],
] as const) {
  expectRejected(`PURGE6_${label}`, () => {
    const baseIntentRow: PurgeSqlRow = {
      page_path: `canon/bad-${label.toLowerCase()}.md`, purge_receipt_id: eventRootId,
      source_key: null, intent_revision: 1, write_state: "staged", codec: "kizuki.canon-erasure-intent/v2", intent: "{}", digest: "e".repeat(64),
    };
    const row: PurgeSqlRow = {...baseIntentRow, ...patch};
    const columns = Object.keys(row);
    db.query(`INSERT INTO canon_source_erasure_intents_v5(${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]!));
  }, expected);
}
for (const [label, assignment] of [
  ["PAGE", "page_path='canon/other.md'"],
  ["PURGE", `purge_receipt_id='${sourceRootId}'`],
  ["SOURCE", "source_key='source-1'"],
] as const) {
  expectRejected(`PURGE6_CANON_INTENT_${label}_IMMUTABLE`, () => db.exec(
    `UPDATE canon_source_erasure_intents_v5 SET ${assignment} WHERE page_path='canon/event.md'`,
  ), "canon intent ownership is immutable");
}
// Valid SQL state progression does not prove the required full-digest CAS or
// machine-byte admission; those remain production transaction obligations.
db.exec(`UPDATE canon_source_erasure_intents_v5 SET write_state='admitted'
  WHERE page_path='canon/event.md';
  UPDATE canon_source_erasure_intents_v5 SET write_state='receipted'
  WHERE page_path='canon/event.md'`);
console.log("PURGE6_CANON_INTENT_WRITE_STATES_STRUCTURAL_PASS");
db.transaction(() => {
  db.exec(`UPDATE event_purges_v6 SET phase='maintenance',connector_id=NULL,
    reason=NULL,source_authority=NULL`);
  db.exec(`UPDATE purge_ops_v6 SET phase='maintenance',ids='[]',proof='{}',
    work_binding=NULL,work_revision=NULL,work_digest=NULL`);
})();
const pendingMaintenance = db.query<{ receipts: number; ops: number }, []>(
  `SELECT (SELECT count(*) FROM event_purges_v6 WHERE state='pending' AND phase='maintenance'
      AND connector_id IS NULL AND reason IS NULL AND source_authority IS NULL) AS receipts,
    (SELECT count(*) FROM purge_ops_v6 WHERE state='pending' AND phase='maintenance'
      AND ids='[]' AND proof IS NOT NULL AND work_binding IS NULL
      AND work_revision IS NULL AND work_digest IS NULL) AS ops`,
).get()!;
if (pendingMaintenance.receipts !== 4 || pendingMaintenance.ops !== 3) {
  throw new Error("pending maintenance did not scrub SQL execution fields");
}
console.log("PURGE6_WORK_TO_PENDING_MAINTENANCE_SCRUB_STRUCTURAL_PASS");
for (const [label, assignment] of [
  ["RECEIPT_MAINTENANCE_REASON", "reason='retained text'"],
  ["RECEIPT_MAINTENANCE_AUTHORITY", "source_authority='{}'"],
  ["RECEIPT_MAINTENANCE_DONE_AT", "done_at='2026-09-05T12:01:00.000Z'"],
] as const) {
  expectRejected(`PURGE6_${label}`, () => db.query(
    `UPDATE event_purges_v6 SET ${assignment} WHERE receipt_id=?`,
  ).run(sourceRootId), "CHECK constraint failed");
}
db.transaction(() => {
  db.query(`UPDATE event_purges_v6 SET state='done',phase=NULL,
    done_at='2026-09-05T12:02:00.000Z',terminal_integrity=?`).run("d".repeat(64));
  db.exec(`UPDATE purge_ops_v6 SET state='done',phase=NULL,ids=NULL,proof=NULL,
    completion='{}',done_at='2026-09-05T12:02:00.000Z'`);
})();
const terminalRows = db.query<{ receipts: number; ops: number }, []>(
  `SELECT (SELECT count(*) FROM event_purges_v6 WHERE state='done' AND phase IS NULL
      AND done_at IS NOT NULL AND terminal_integrity IS NOT NULL
      AND connector_id IS NULL AND reason IS NULL AND source_authority IS NULL) AS receipts,
    (SELECT count(*) FROM purge_ops_v6 WHERE state='done' AND phase IS NULL
      AND ids IS NULL AND proof IS NULL AND completion IS NOT NULL AND done_at IS NOT NULL) AS ops`,
).get()!;
if (terminalRows.receipts !== 4 || terminalRows.ops !== 3) throw new Error("terminal SQL arms were not scrubbed");
console.log("PURGE6_MAINTENANCE_TO_TERMINAL_ARMS_STRUCTURAL_PASS");
for (const [label, table, key, id, assignment] of [
  ["TERMINAL_RECEIPT_REASON", "event_purges_v6", "receipt_id", sourceRootId, "reason='retained text'"],
  ["TERMINAL_RECEIPT_CONNECTOR", "event_purges_v6", "receipt_id", eventRootId, "connector_id='retained source'"],
  ["TERMINAL_RECEIPT_AUTHORITY", "event_purges_v6", "receipt_id", sourceRootId, "source_authority='{}'"],
  ["TERMINAL_RECEIPT_NO_INTEGRITY", "event_purges_v6", "receipt_id", sourceRootId, "terminal_integrity=NULL"],
  ["TERMINAL_RECEIPT_NO_DONE_AT", "event_purges_v6", "receipt_id", sourceRootId, "done_at=NULL"],
  ["TERMINAL_OP_IDS", "purge_ops_v6", "op_id", eventWorkId, "ids='[]'"],
  ["TERMINAL_OP_PROOF", "purge_ops_v6", "op_id", eventWorkId, "proof='{}'"],
  ["TERMINAL_OP_NO_COMPLETION", "purge_ops_v6", "op_id", eventWorkId, "completion=NULL"],
  ["TERMINAL_OP_NO_DONE_AT", "purge_ops_v6", "op_id", eventWorkId, "done_at=NULL"],
  ["TERMINAL_OP_PHASE", "purge_ops_v6", "op_id", eventWorkId, "phase='maintenance'"],
  ["TERMINAL_OP_WORK_BINDING", "purge_ops_v6", "op_id", eventWorkId, "work_binding='{}'"],
  ["TERMINAL_OP_WORK_REVISION", "purge_ops_v6", "op_id", eventWorkId, "work_revision=1"],
  ["TERMINAL_OP_WORK_DIGEST", "purge_ops_v6", "op_id", eventWorkId, `work_digest='${"a".repeat(64)}'`],
] as const) {
  expectRejected(`PURGE6_${label}`, () => db.query(
    `UPDATE ${table} SET ${assignment} WHERE ${key}=?`,
  ).run(id), "CHECK constraint failed");
}
for (const [label, table, assignment, key, id] of [
  ["RECEIPT_ORIGIN", "event_purges_v6", "id_origin='legacy_unverified'", "receipt_id", sourceRootId],
  ["RECEIPT_COPIED_EVENT_ORIGIN", "event_purges_v6", "event_id_origin='legacy_unverified'", "receipt_id", eventRootId],
  ["RECEIPT_BATCH", "event_purges_v6", `batch_receipt_id='${sourceRootId}'`, "receipt_id", eventRootId],
  ["OP_ORIGIN", "purge_ops_v6", "id_origin='legacy_unverified'", "op_id", eventWorkId],
  ["OP_PARENT", "purge_ops_v6", `receipt_id='${sourceRootId}'`, "op_id", eventWorkId],
  ["OP_STORE", "purge_ops_v6", "store='graph'", "op_id", eventWorkId],
] as const) {
  expectRejected(`PURGE6_${label}_IDENTITY_IMMUTABLE`, () => db.query(
    `UPDATE ${table} SET ${assignment} WHERE ${key}=?`,
  ).run(id), "identifier origin is immutable");
}
expectRejected("EVENT_ID_ORIGIN_IMMUTABLE", () => {
  db.exec("UPDATE events SET id_origin='imported_unverified',id_allocator_version=NULL WHERE event_id='00000000000000000000061001'");
}, "identifier origin is immutable");
console.log("PURGE6_ID_ORIGIN_IMMUTABILITY_STRUCTURAL_PASS");
// SQL's uniqueness enforces at most one coordinator, not its existence or its
// placement at a root. These accepted rows must be rejected by the closed
// codecs/transaction validator; leave no such rows in this probe's final state.
db.exec("SAVEPOINT application_obligations");
insertPurgeRow("event_purges_v6", {...eventRoot,
  receipt_id: purgeId(100),batch_receipt_id: eventChildId,event_id: purgeId(101)});
insertPurgeRow("purge_ops_v6", {...reservationCoordinator,
  op_id: purgeId(100),receipt_id: eventChildId});
insertPurgeRow("purge_ops_v6", {...reservationCoordinator,
  op_id: purgeId(101),receipt_id: eventRootId,store: "ledger_sqlite",ids: "[]",
  work_binding: purgeWorkBinding,work_revision: 1,work_digest: purgeWorkDigest});
db.exec("ROLLBACK TO application_obligations; RELEASE application_obligations");
console.log("PURGE6_ROOT_MEMBERSHIP_COORDINATOR_EXISTENCE_AND_EMPTY_NONCOORDINATOR_WORK_REQUIRE_APPLICATION_REJECTION");
console.log("PURGE6_SOURCE_AUTHORITY_CODECS_MANIFEST_AGREEMENT_AND_REAL_MAINTENANCE_NOT_EXECUTED");
console.log('STORAGE_DESIGN_CONSTRAINT_PROBE_COMPLETE');
