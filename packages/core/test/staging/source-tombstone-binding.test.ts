import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim } from "../../src/claims/store";
import { accept } from "../../src/ledger/ledger";
import { commitMachineByteIntent } from "../../src/ledger/event-origin";
import { runBatch } from "../../src/ingest/run";
import { cascadeTombstone, proposalsForEvent } from "../../src/staging/producers";
import { fileProposal, listProposals } from "../../src/staging/proposals";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { parseFrontmatter, serializePage } from "../../src/vault/frontmatter";
import { validEvent } from "../fixtures";
import { canonFixture, write, type CanonFixture } from "../canon/helpers";

function setup(self: boolean) {
  const fixture = canonFixture();
  const accepted = accept(fixture.db, validEvent());
  if (accepted.status !== "stored") throw new Error("source admission failed");
  const proposal = fileProposal(fixture.db, proposalsForEvent(accepted.event).find(item => item.kind === "claim")!).proposal;
  const receipt = write(fixture.io, getClaim(fixture.db, proposal.proposal_id)!);
  const text = self ? "synthetic machine deletion" : "synthetic source deletion";
  if (self) commitMachineByteIntent(fixture.db, {
    receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(text),
  }, () => {});
  const deleted = accept(fixture.db, { ...validEvent(), deleted: true, text });
  if (deleted.status !== "stored") throw new Error("tombstone admission failed");
  return { ...fixture, receipt, tombstone: deleted.event };
}

function effects(fixture: CanonFixture) {
  const tables = ["claims", "proposals", "canon_receipts", "canon_machine_byte_intents", "page_index",
    "search_documents", "search_docs", "graph_edges"];
  const files = (directory: string): [string, string][] => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) :
      entry.name.endsWith(".md") && !directory.startsWith(join(fixture.vault, "archive")) ? [] :
      [[join(directory, entry.name), sha256Hex(readFileSync(join(directory, entry.name)))]] as [string, string][]);
  return { rows: tables.map(table => fixture.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    writer_files: files(fixture.vault) };
}

function replace(fixture: ReturnType<typeof setup>, mode: "identity" | "bytes" | "membership") {
  const path = join(fixture.vault, fixture.receipt.page_path);
  const page = parseFrontmatter(readFileSync(path, "utf8"));
  if (mode === "identity") page.data["id"] = ulid();
  if (mode === "bytes") page.body = "Unrelated replacement body.\n";
  if (mode === "membership") page.data["sources"] = [];
  const bytes = serializePage(page);
  writeFileSync(path, bytes);
  return bytes;
}

describe("source tombstones bind the current canon object", () => {
  for (const self of [false, true]) {
    test.each(["identity", "bytes", "membership"] as const)(
      `replacement before cascade files no deletion (self=${self}, %s)`, mode => {
        const fixture = setup(self);
        try {
          const bytes = replace(fixture, mode);
          const before = effects(fixture);
          expect(cascadeTombstone(fixture.db, fixture.tombstone, fixture.io).retractions_filed).toEqual([]);
          expect(effects(fixture)).toEqual(before);
          expect(readFileSync(join(fixture.vault, fixture.receipt.page_path), "utf8")).toBe(bytes);
        } finally { fixture.dispose(); }
      },
    );

    test(`same source and unchanged current object can archive (self=${self})`, () => {
      const fixture = setup(self);
      try {
        const before = readFileSync(join(fixture.vault, fixture.receipt.page_path), "utf8");
        expect(cascadeTombstone(fixture.db, fixture.tombstone, fixture.io).retractions_filed).toHaveLength(1);
        const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
        expect(deletion.frontmatter).toMatchObject({
          "x-page-id": parseFrontmatter(before).data["id"],
          "x-page-hash": fixture.receipt.after_hash,
          "x-page-receipt": fixture.receipt.receipt_id,
        });
        const filed = effects(fixture);
        expect(cascadeTombstone(fixture.db, fixture.tombstone, fixture.io).retractions_filed).toEqual([]);
        expect(fileProposal(fixture.db, deletion, fixture.io).outcome).toBe("duplicate");
        expect(effects(fixture)).toEqual(filed);
        expect(write(fixture.io, getClaim(fixture.db, deletion.proposal_id)!).page_action).toBe("archive");
      } finally { fixture.dispose(); }
    });

    test(`replacement after filing refuses public refiling and writer (self=${self})`, () => {
      const fixture = setup(self);
      try {
        cascadeTombstone(fixture.db, fixture.tombstone, fixture.io);
        const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
        const bytes = replace(fixture, "identity");
        const before = effects(fixture);
        expect(() => fileProposal(fixture.db, deletion, fixture.io)).toThrow("source_tombstone_stale");
        expect(() => write(fixture.io, getClaim(fixture.db, deletion.proposal_id)!)).toThrow("source_tombstone_stale");
        expect(effects(fixture)).toEqual(before);
        expect(readFileSync(join(fixture.vault, fixture.receipt.page_path), "utf8")).toBe(bytes);
      } finally { fixture.dispose(); }
    });

    test(`a later receipted same-path page without this source is not a retraction target (self=${self})`, () => {
      const fixture = setup(self);
      try {
        unlinkSync(join(fixture.vault, fixture.receipt.page_path));
        const accepted = accept(fixture.db, { ...validEvent(), source_record_id: "unrelated-source-record",
          text: "Independent replacement evidence" });
        if (accepted.status !== "stored") throw new Error("replacement evidence admission failed");
        const input = proposalsForEvent(accepted.event).find(item => item.kind === "claim")!;
        const proposal = fileProposal(fixture.db, { ...input,
          target: fixture.receipt.page_path.replace(/\.md$/, "") }).proposal;
        const replacement = write(fixture.io, getClaim(fixture.db, proposal.proposal_id)!);
        const bytes = readFileSync(join(fixture.vault, replacement.page_path), "utf8");
        const before = effects(fixture);
        expect(cascadeTombstone(fixture.db, fixture.tombstone, fixture.io).retractions_filed).toEqual([]);
        expect(effects(fixture)).toEqual(before);
        expect(readFileSync(join(fixture.vault, replacement.page_path), "utf8")).toBe(bytes);
      } finally { fixture.dispose(); }
    });

    test(`a later write with an earlier clock invalidates the old binding and can be rebound (self=${self})`, () => {
      const fixture = setup(self);
      try {
        cascadeTombstone(fixture.db, fixture.tombstone, fixture.io);
        const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
        const accepted = accept(fixture.db, { ...validEvent(), source_record_id: "other-record",
          text: "A later independent page contribution" });
        if (accepted.status !== "stored") throw new Error("later evidence admission failed");
        const input = proposalsForEvent(accepted.event).find(item => item.kind === "claim")!;
        const proposal = fileProposal(fixture.db, { ...input,
          target: fixture.receipt.page_path.replace(/\.md$/, "") }).proposal;
        const later = write({ ...fixture.io, now: () => "2020-01-01T00:00:00Z" }, getClaim(fixture.db, proposal.proposal_id)!);
        expect(later.at < fixture.receipt.at).toBe(true);
        const bytes = readFileSync(join(fixture.vault, fixture.receipt.page_path), "utf8");
        const before = effects(fixture);
        expect(() => write(fixture.io, getClaim(fixture.db, deletion.proposal_id)!)).toThrow("source_tombstone_stale");
        expect(effects(fixture)).toEqual(before);
        expect(readFileSync(join(fixture.vault, fixture.receipt.page_path), "utf8")).toBe(bytes);
        expect(cascadeTombstone(fixture.db, fixture.tombstone, fixture.io).retractions_filed).toHaveLength(1);
        const current = listProposals(fixture.db, { kind: "deletion" }).find(item => item.proposal_id !== deletion.proposal_id)!;
        expect(current.frontmatter["x-page-receipt"]).toBe(later.receipt_id);
        expect(write(fixture.io, getClaim(fixture.db, current.proposal_id)!).page_action).toBe("archive");
      } finally { fixture.dispose(); }
    });

    test(`replacement between preparation and final admission makes no intent (self=${self})`, () => {
      const fixture = setup(self);
      try {
        cascadeTombstone(fixture.db, fixture.tombstone, fixture.io);
        const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
        const claim = getClaim(fixture.db, deletion.proposal_id)!;
        const decision = resolveTarget(fixture.io, claim);
        const before = effects(fixture);
        const budget = createBudgetTracker({ canon_writes_per_run: 10 });
        let replaced = "";
        expect(() => applyCanonWrite(fixture.io, claim, decision, { writer: "loop", budget: {
          usage: () => budget.usage(),
          chargeWrite: () => { replaced = replace(fixture, "membership"); },
        } })).toThrow("source_tombstone_stale");
        expect(replaced).not.toBe("");
        expect(effects(fixture)).toEqual(before);
        expect(readFileSync(join(fixture.vault, fixture.receipt.page_path), "utf8")).toBe(replaced);
      } finally { fixture.dispose(); }
    });
  }

  test("missing vault context refuses the complete promoted-page cascade", () => {
    const fixture = setup(false);
    try {
      const original = accept(fixture.db, { ...validEvent(), text: "still pending revision" });
      if (original.status !== "stored") throw new Error("pending source admission failed");
      fileProposal(fixture.db, proposalsForEvent(original.event)[0]!);
      const before = effects(fixture);
      expect(() => cascadeTombstone(fixture.db, fixture.tombstone)).toThrow("source_tombstone_vault_required");
      expect(effects(fixture)).toEqual(before);
      const result = runBatch(fixture.db, { events: [{ ...validEvent(), deleted: true,
        text: "later deletion without context" }], cursor: null }, { page_candidates: false });
      expect(result.errors).toEqual(["source_tombstone_vault_required"]);
      expect(result.stored).toBe(0);
      expect(effects(fixture)).toEqual(before);
    } finally { fixture.dispose(); }
  });

  test("an unbound legacy source deletion cannot replay through the external-origin path", () => {
    const fixture = setup(false);
    try {
      cascadeTombstone(fixture.db, fixture.tombstone, fixture.io);
      const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
      fixture.db.query("UPDATE claims SET frontmatter=? WHERE claim_id=?").run(JSON.stringify({
        "x-connector": fixture.tombstone.connector_id,
        "x-source-record-id": fixture.tombstone.source_record_id,
        "x-page-proposal": "legacy-unbound",
      }), deletion.proposal_id);
      const before = effects(fixture);
      expect(() => write(fixture.io, getClaim(fixture.db, deletion.proposal_id)!)).toThrow("source_tombstone_stale");
      expect(effects(fixture)).toEqual(before);
    } finally { fixture.dispose(); }
  });

  test("a valid current retraction does not reuse a legacy path-only deletion", () => {
    const fixture = setup(false);
    try {
      cascadeTombstone(fixture.db, fixture.tombstone, fixture.io);
      const deletion = listProposals(fixture.db, { kind: "deletion" })[0]!;
      const body = `Source record \`${fixture.tombstone.source_record_id}\` was deleted at ` +
        `\`${fixture.tombstone.connector_id}\`; canon page \`${fixture.receipt.page_path}\` cites it.`;
      const frontmatter = JSON.stringify({ "x-connector": fixture.tombstone.connector_id,
        "x-source-record-id": fixture.tombstone.source_record_id, "x-page-proposal": "legacy-unbound" });
      fixture.db.query("UPDATE claims SET body=?,body_hash=?,frontmatter=? WHERE claim_id=?")
        .run(body, sha256Hex(body), frontmatter, deletion.proposal_id);
      fixture.db.query("UPDATE proposals SET body=?,body_hash=?,frontmatter=? WHERE proposal_id=?")
        .run(body, sha256Hex(body), frontmatter, deletion.proposal_id);
      expect(cascadeTombstone(fixture.db, fixture.tombstone, fixture.io).retractions_filed).toHaveLength(1);
      const current = listProposals(fixture.db, { kind: "deletion" }).find(item => item.proposal_id !== deletion.proposal_id)!;
      expect(write(fixture.io, getClaim(fixture.db, current.proposal_id)!).page_action).toBe("archive");
    } finally { fixture.dispose(); }
  });
});
