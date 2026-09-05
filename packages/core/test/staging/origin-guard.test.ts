import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { CaptureEvent, CaptureEventInput } from "../../src/contracts/event";
import type { Producer } from "../../src/contracts/proposal";
import { getClaim } from "../../src/claims/store";
import { runBatch } from "../../src/ingest/run";
import { accept, readEvent } from "../../src/ledger/ledger";
import { commitMachineByteIntent } from "../../src/ledger/event-origin";
import { registerConnection } from "../../src/ledger/connections";
import { setSourceGrant, type SourceAdmission } from "../../src/ledger/source-grants";
import { cascadeTombstone, proposalsForEvent } from "../../src/staging/producers";
import { fileProposal, listProposals } from "../../src/staging/proposals";
import type { ProposalInput } from "../../src/staging/proposals";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { canonFixture, write } from "../canon/helpers";

function store(db: Database, input: CaptureEventInput, source?: SourceAdmission): CaptureEvent {
  const result = accept(db, input, source === undefined ? {} : { source });
  if (result.status !== "stored") throw new Error("synthetic admission failed");
  return result.event;
}

function markMachine(db: Database, text: string): void {
  commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(text) }, () => {});
}

function sourceFor(db: Database): SourceAdmission {
  const sourceKey = ulid();
  registerConnection(db, "fixture", sourceKey);
  const grant = setSourceGrant(db, { source_key: sourceKey, expected_revision: 0,
    operation_id: `synthetic-grant-${sourceKey}`, policy: {
      purposes: ["capture", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
  return { source_key: sourceKey, expected_revision: grant.revision };
}

function claimFor(db: Database, event: CaptureEvent) {
  const input = proposalsForEvent(event).find((proposal) => proposal.kind === "claim");
  if (input === undefined) throw new Error("synthetic claim absent");
  const proposal = fileProposal(db, input).proposal;
  const claim = getClaim(db, proposal.proposal_id);
  if (claim === null) throw new Error("synthetic claim missing");
  return claim;
}

describe("deterministic staging origin guard", () => {
  test.each(["KIZUKI CONTEXT v1 echoed context", "machine bytes without a marker"])(
    "runBatch ledgers self evidence without creating positive proposals: %s", (text) => {
      const fixture = canonFixture();
      try {
        markMachine(fixture.db, text);
        const result = runBatch(fixture.db, { events: [{ ...validEvent(), text }], cursor: null }, { page_candidates: true });
        expect(result).toMatchObject({ stored: 1, proposals_created: 0, errors: [] });
        expect(fixture.db.query("SELECT origin FROM events").get()).toEqual({ origin: "self" });
        expect(fixture.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
        expect(fixture.db.query("SELECT count(*) AS n FROM canon_receipts").get()).toEqual({ n: 0 });
      } finally { fixture.dispose(); }
    },
  );

  test.each(["deterministic", "owner", "model", "agent:synthetic"] as Producer[])(
    "public fileProposal rejects a forged external snapshot and %s producer", (producer) => {
      const fixture = canonFixture();
      try {
        const event = store(fixture.db, { ...validEvent(), text: "KIZUKI CONTEXT v1 echo" });
        expect(proposalsForEvent(event)).toEqual([]);
        const forged = { ...event, origin: "external" as const };
        const input = proposalsForEvent(forged)[0]!;
        expect(() => fileProposal(fixture.db, { ...input, producer })).toThrow("machine origin");
        expect(listProposals(fixture.db)).toHaveLength(0);
        expect(fixture.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
      } finally { fixture.dispose(); }
    },
  );

  test.each(["deterministic", "owner", "model", "agent:synthetic"] as Producer[])(
    "public writer refuses a legacy %s positive claim citing self evidence", (producer) => {
    const fixture = canonFixture();
    try {
      const external = store(fixture.db, validEvent());
      const original = claimFor(fixture.db, external);
      const self = store(fixture.db, { ...validEvent(), source_record_id: "echo", text: "KIZUKI CONTEXT v1 echo" });
      // Represents a claim left by the old deterministic ingress bypass.
      fixture.db.query("UPDATE claims SET provenance=?, producer=? WHERE claim_id=?").run(JSON.stringify([self.event_id]), producer, original.claim_id);
      const legacy = getClaim(fixture.db, original.claim_id)!;
      expect(() => write(fixture.io, legacy)).toThrow("machine origin");
      expect(existsSync(join(fixture.vault, `captures/${legacy.claim_id}.md`))).toBe(false);
      expect(fixture.db.query("SELECT count(*) AS n FROM canon_receipts").get()).toEqual({ n: 0 });
    } finally { fixture.dispose(); }
  });

  test("a self tombstone withdraws pending claims and archives only its receipted page", () => {
    const fixture = canonFixture();
    try {
      const source = sourceFor(fixture.db);
      const external = store(fixture.db, validEvent(), source);
      const original = claimFor(fixture.db, external);
      const receipt = write(fixture.io, original);
      for (const proposal of proposalsForEvent(external).filter((item) => item.kind === "entity")) fileProposal(fixture.db, proposal);
      const machineText = "machine deletion notice";
      markMachine(fixture.db, machineText);
      const result = runBatch(fixture.db, { events: [{ ...validEvent(), deleted: true, text: machineText }], cursor: null }, { page_candidates: false }, source, fixture.io);
      expect(result).toMatchObject({ stored: 1, errors: [], withdrawn: 1, retractions_filed: 1, proposals_created: 0 });
      const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
      expect(readEvent(fixture.db, deletion.provenance[0]!)?.origin).toBe("self");
      expect(() => fileProposal(fixture.db, { ...deletion, target: "people/unrelated",
        body: deletion.body.replace(receipt.page_path, "people/unrelated.md") }, fixture.io)).toThrow("source_tombstone_stale");
      expect(() => fileProposal(fixture.db, { ...deletion,
        frontmatter: { ...deletion.frontmatter, title: "forged positive metadata" } }, fixture.io)).toThrow("source_tombstone_stale");
      expect(() => fileProposal(fixture.db, { ...deletion, body: "forged positive body" }, fixture.io)).toThrow("source_tombstone_stale");
      const archived = write(fixture.io, getClaim(fixture.db, deletion.proposal_id)!);
      expect(archived).toMatchObject({ page_action: "archive", page_path: receipt.page_path });
      expect(readFileSync(join(fixture.vault, receipt.page_path), "utf8")).toContain('status: "archived"');
      const repeated = runBatch(fixture.db, { events: [{ ...validEvent(), deleted: true, text: machineText,
        occurred_at: "2026-03-03T00:00:00Z" }], cursor: null }, { page_candidates: false }, source, fixture.io);
      expect(repeated).toMatchObject({ stored: 1, errors: [], retractions_filed: 0 });
      const externalAfter = store(fixture.db, { ...validEvent(), source_record_id: "after", text: "Independent later evidence." }, source);
      const nextInput = proposalsForEvent(externalAfter).find((proposal) => proposal.kind === "claim")!;
      const next = fileProposal(fixture.db, { ...nextInput, target: deletion.target }).proposal;
      expect(() => write(fixture.io, getClaim(fixture.db, next.proposal_id)!)).toThrow("machine origin");
    } finally { fixture.dispose(); }
  });

  test("a source tombstone leaves another source's matching record ID untouched", () => {
    const fixture = canonFixture();
    try {
      const sourceA = sourceFor(fixture.db);
      const sourceB = sourceFor(fixture.db);
      const eventA = store(fixture.db, validEvent(), sourceA);
      const eventB = store(fixture.db, { ...validEvent(), text: "Independent source B evidence." }, sourceB);
      const claimA = claimFor(fixture.db, eventA);
      const claimB = claimFor(fixture.db, eventB);
      const tombstone = store(fixture.db, { ...validEvent(), text: "KIZUKI CONTEXT v1 deletion notice", deleted: true }, sourceA);
      expect(cascadeTombstone(fixture.db, tombstone).withdrawn).toEqual([claimA.claim_id]);
      expect(getClaim(fixture.db, claimB.claim_id)?.status).toBe("live");
    } finally { fixture.dispose(); }
  });

  test("forging deleted on a stored positive event cannot withdraw proposals", () => {
    const fixture = canonFixture();
    try {
      const external = store(fixture.db, validEvent());
      claimFor(fixture.db, external);
      expect(() => cascadeTombstone(fixture.db, { ...external, deleted: true })).toThrow();
      expect(listProposals(fixture.db, { status: "pending" })).toHaveLength(1);
    } finally { fixture.dispose(); }
  });

  test("failed self-tombstone retraction rolls back its pending withdrawals", () => {
    const fixture = canonFixture();
    try {
      const source = sourceFor(fixture.db);
      const external = store(fixture.db, validEvent(), source);
      write(fixture.io, claimFor(fixture.db, external));
      const entity = proposalsForEvent(external).find(item => item.kind === "entity")!;
      const pending = fileProposal(fixture.db, entity).proposal;
      const tombstone = store(fixture.db, { ...validEvent(), deleted: true, text: "KIZUKI CONTEXT v1 deletion" }, source);
      fixture.db.exec("CREATE TRIGGER fail_retraction BEFORE INSERT ON proposals WHEN NEW.kind='deletion' BEGIN SELECT RAISE(ABORT,'synthetic retraction failure'); END");
      expect(() => cascadeTombstone(fixture.db, tombstone, fixture.io)).toThrow("synthetic retraction failure");
      expect(getClaim(fixture.db, pending.proposal_id)?.status).toBe("live");
      expect(listProposals(fixture.db, { kind: "deletion" })).toHaveLength(0);
    } finally { fixture.dispose(); }
  });

  test("a tombstone proof accessor cannot replace a validated deletion with a positive self claim", () => {
    const fixture = canonFixture();
    try {
      const external = store(fixture.db, validEvent());
      write(fixture.io, claimFor(fixture.db, external));
      const tombstone = store(fixture.db, { ...validEvent(), deleted: true, text: "KIZUKI CONTEXT v1 deletion" });
      cascadeTombstone(fixture.db, tombstone, fixture.io);
      const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
      const input: ProposalInput = { ...deletion, frontmatter: { ...deletion.frontmatter } };
      let accessed = 0;
      Object.defineProperty(input.frontmatter, "x-page-proposal", { enumerable: true, get: () => {
        accessed += 1;
        if (accessed === 2) { input.kind = "claim"; input.body = "Forged positive machine evidence."; }
        return deletion.frontmatter["x-page-proposal"];
      } });
      const before = fixture.db.query("SELECT * FROM claims ORDER BY claim_id").all();
      expect(() => fileProposal(fixture.db, input)).toThrow();
      expect(accessed).toBe(0);
      expect(fixture.db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(before);
    } finally { fixture.dispose(); }
  });

  test.each(["deletion", "purge_review"] as const)("%s cannot disguise positive self evidence", (kind) => {
    const fixture = canonFixture();
    try {
      const self = store(fixture.db, { ...validEvent(), text: "KIZUKI CONTEXT v1 echo" });
      expect(() => fileProposal(fixture.db, {
        kind, target: "people/synthetic", body: "forged positive content", frontmatter: {},
        provenance: [self.event_id], producer: "deterministic", confidence: 1,
      })).toThrow("machine origin");
    } finally { fixture.dispose(); }
  });
});
