import { expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { registerConnection } from "../../src/index";
import { setSourceGrant, inspectSourceGrant, revokeSourceGrant } from "../../src/ledger/source-grants";
import { addAgent, authenticate, setGrant, rotateToken, revokeAgent } from "../../src/agents";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { ulid } from "../../src/util/ulid";
import { ErasurePendingError } from "../../src/canon/positive-authority";
import { fileProposal, setProposalStatus } from "../../src/staging/proposals";
import { memoryDb, proposalInput, seedEvent, event as legacyEvent } from "../staging/helpers";

const policy = { purposes: ["capture", "recall", "derive", "export"], allowed_fields: ["text", "subjects", "metadata", "attachments"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };
function stage(db: ReturnType<typeof openLedger>) { db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("private-path", "unrelated-source", "{}", "unreadable"); }

test("pending erasure refuses new source authority, preserves exact grant replay, and permits capture and revoke", () => {
  const db = openLedger(":memory:");
  try {
    const source = ulid(); registerConnection(db, "kizuki.fixture", source);
    const request = { source_key: source, expected_revision: 0, operation_id: "source-initial", policy };
    const receipt = setSourceGrant(db, request); stage(db);
    expect(setSourceGrant(db, request)).toEqual(receipt);
    const before = inspectSourceGrant(db, source);
    expect(() => setSourceGrant(db, { ...request, expected_revision: 1, operation_id: "source-again" })).toThrow(ErasurePendingError);
    expect(inspectSourceGrant(db, source)).toEqual(before);
    expect(db.query("SELECT 1 FROM source_grant_receipts WHERE operation_id='source-again'").get()).toBeNull();
    expect(accept(db, { ...validEvent(), connector_id: "kizuki.fixture" }, { source: { source_key: source, expected_revision: 1 } }).status).toBe("stored");
    expect(revokeSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: "source-revoke" }).status).toBe("denied");
  } finally { db.close(); }
});

test("pending erasure leaves agent authority and credential identity unchanged while allowing revoke", () => {
  const db = openLedger(":memory:");
  try {
    const initial = addAgent(db, "existing-agent"); stage(db);
    const before = authenticate(db, initial.token);
    expect(() => addAgent(db, "another-agent")).toThrow(ErasurePendingError);
    expect(() => setGrant(db, "existing-agent", { ceiling: "public" })).toThrow(ErasurePendingError);
    expect(() => rotateToken(db, "existing-agent")).toThrow(ErasurePendingError);
    expect(authenticate(db, initial.token)).toEqual(before);
    expect(db.query("SELECT 1 FROM agents WHERE name='another-agent'").get()).toBeNull();
    expect(() => revokeAgent(db, "existing-agent")).not.toThrow();
    expect(authenticate(db, initial.token)).toBeNull();
  } finally { db.close(); }
});

test("legacy proposal mutations share the authority fence while exact delivery remains idempotent", () => {
  const db = memoryDb();
  try {
    const input = proposalInput(), original = fileProposal(db, input).proposal;
    const later = seedEvent(db, legacyEvent({ event_id: ulid(), source_record_id: "second-synthetic-record" }));
    const before = db.query("SELECT * FROM claims ORDER BY claim_id").all();
    stage(db);
    expect(fileProposal(db, input)).toEqual({ outcome: "duplicate", proposal: original });
    expect(() => fileProposal(db, { ...input, body: "A new synthetic proposal." })).toThrow(ErasurePendingError);
    expect(() => fileProposal(db, { ...input, provenance: [...input.provenance, later.event_id] })).toThrow(ErasurePendingError);
    expect(() => setProposalStatus(db, original.proposal_id, "withdrawn")).toThrow(ErasurePendingError);
    expect(db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(before);
    expect(db.query("SELECT count(*) AS n FROM proposals").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

import { canonFixture, putEvent, storeClaim, write } from "./helpers";
import { getClaim, markClaimReverted, reinstateClaim, resupersedeClaim, skipUnwrittenClaim, reviveUncontestedSkipped } from "../../src/claims/store";
import { undoReceipt } from "../../src/canon/undo";
import { skipCaptureFanoutClaims } from "../../src/claims/capture-fanout";

test("pending erasure prevents capture fanout repair from changing claim lifecycle", async () => {
  const f = canonFixture();
  try {
    const id = putEvent(f.db, { source_record_id: "session-1/1", text: "turn 1" });
    const claim = await storeClaim(f.db, id, { kind: "claim", target: "captures/session-connector/2026-09-01", subject: null, predicate: null, object: null,
      body: "Captured from session connector: turn 1", frontmatter: { type: "source", title: "Capture from session connector", "x-connector": "session-connector", "x-capture-kind": "message" },
      subjects: [], confidence: 1, taint: "quoted", sensitivity: "private" });
    stage(f.db);
    expect(() => skipCaptureFanoutClaims(f.db, "2026-10-21T00:00:00Z")).toThrow(ErasurePendingError);
    expect(getClaim(f.db, claim.claim_id)).toEqual(claim);
  } finally { f.dispose(); }
});

test("pending erasure leaves ordinary claim lifecycle, canon bytes and undo untouched", async () => {
  const f = canonFixture();
  try {
    const event = putEvent(f.db), claim = await storeClaim(f.db, event);
    const receipt = write(f.io, claim);
    const before = getClaim(f.db, claim.claim_id);
    const counts = () => f.db.query("SELECT (SELECT count(*) FROM canon_receipts) receipts,(SELECT count(*) FROM claims) claims,(SELECT count(*) FROM canon_write_intents) intents").get();
    const beforeCounts = counts(); stage(f.db);
    for (const change of [
      () => markClaimReverted(f.db, claim.claim_id, "2026-10-21T00:00:00Z"),
      () => reinstateClaim(f.db, claim.claim_id, null),
      () => resupersedeClaim(f.db, claim.claim_id, claim.claim_id, "2026-10-21T00:00:00Z", null),
      () => skipUnwrittenClaim(f.db, claim.claim_id, "2026-10-21T00:00:00Z"),
      () => reviveUncontestedSkipped(f.db),
    ]) expect(change).toThrow(ErasurePendingError);
    await expect(undoReceipt(f.io, receipt.receipt_id)).rejects.toThrow(ErasurePendingError);
    await expect(storeClaim(f.db, event, { body: "A distinct synthetic claim.", object: "other" })).rejects.toThrow(ErasurePendingError);
    expect(getClaim(f.db, claim.claim_id)).toEqual(before);
    expect(counts()).toEqual(beforeCounts);
    f.db.query("DELETE FROM canon_source_erasure_intents").run();
    await expect(undoReceipt(f.io, receipt.receipt_id)).resolves.toMatchObject({ kind: "revert" });
  } finally { f.dispose(); }
});
