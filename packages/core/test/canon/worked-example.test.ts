import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import { createBudgetTracker } from "../../src/canon/budget";
import { RECEIPTS_PATH, getCanonReceipt } from "../../src/canon/receipts";
import { getClaim, insertClaim } from "../../src/claims/store";
import type { Claim } from "../../src/contracts/proposal";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { canonFixture, sha256 } from "./helpers";
import type { CanonFixture } from "./helpers";

/**
 * RFC 0002 §16.1, "A note becomes a page", with the abbreviated ids of the
 * example spelled out as synthetic ULIDs. Bytes are exact against the
 * repository's own frontmatter serializer and receipt encoder.
 */
const EVENT_ID = "01JB00000000000000000000A1";
const CLAIM_WORKS_AT = "01JB00000000000000000000B3";
const CLAIM_EMAIL = "01JB00000000000000000000B4";
const PAGE_ID = "01JB00000000000000000000C7";
const RECEIPT_ID = "01JB00000000000000000000D2";
const AT = "2026-09-02T10:14:03Z";
const MODEL_REF = "kizuki.llm.openai-compatible:synthetic-model@127.0.0.1";

const EXPECTED_PAGE = [
  "---",
  `id: "${PAGE_ID}"`,
  'type: "person"',
  'status: "active"',
  'sensitivity: "private"',
  'taint: "clean"',
  `sources: ["${EVENT_ID}"]`,
  'title: "grace"',
  'x-subject-id: "markdown-folder:grace"',
  "---",
  "Works at acme. Contact: grace@acme.test.",
  "",
].join("\n");

function expectedReceipt(afterHash: string): string {
  return JSON.stringify({
    receipt_id: RECEIPT_ID,
    kind: "write",
    claim_ids: [CLAIM_WORKS_AT, CLAIM_EMAIL],
    page_path: "people/grace.md",
    page_action: "create",
    before_hash: null,
    after_hash: afterHash,
    archive_path: null,
    writer: "loop",
    producer: "model",
    model_ref: MODEL_REF,
    authority: "model_inference",
    confidence: 0.86,
    sensitivity: "private",
    taint: "clean",
    provenance: [EVENT_ID],
    superseded: [],
    candidates: [],
    retrieval_ops: [
      { store: "kizuki.retrieval.fts5", op: "upsert", doc: `page:${PAGE_ID}` },
    ],
    reverts: null,
    reverted_by: null,
    at: AT,
  });
}

const fixtures: CanonFixture[] = [];

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

async function draft(
  fixture: CanonFixture,
  claimId: string,
  predicate: string,
  object: string,
  body: string,
  confidence: number,
): Promise<Claim> {
  const result = await insertClaim(
    { db: fixture.db, now: () => AT },
    {
      claim_id: claimId,
      kind: "claim",
      target: "people/grace",
      subject: "markdown-folder:grace",
      predicate,
      object,
      polarity: "positive",
      body,
      frontmatter: { type: "person", title: "grace", "x-subject-id": "markdown-folder:grace" },
      provenance: [EVENT_ID],
      subjects: ["markdown-folder:grace"],
      producer: "model",
      model_ref: MODEL_REF,
      confidence,
      sensitivity: "private",
      taint: "clean",
    },
  );
  expect(result.outcome).toBe("stored");
  // The example states the model's own confidence on each draft. claims-core
  // clamps a single-source model draft to 0.5 at insert; the example's
  // numbers are restored here so the receipt arithmetic is asserted exactly.
  fixture.db
    .query("UPDATE claims SET confidence = ?, authority = 'model_inference' WHERE claim_id = ?")
    .run(confidence, claimId);
  const stored = getClaim(fixture.db, claimId);
  if (stored === null) throw new Error("fixture claim missing");
  return stored;
}

describe("RFC 0002 §16.1 — a note becomes a page", () => {
  test("the example is reproduced byte-exact: page, receipt line and receipt row", async () => {
    const ids = [PAGE_ID, RECEIPT_ID];
    const fixture = canonFixture({
      now: () => AT,
      ids: () => {
        const next = ids.shift();
        if (next === undefined) throw new Error("the example mints exactly two ids");
        return next;
      },
      retrieval_store: "kizuki.retrieval.fts5",
    });
    fixtures.push(fixture);

    const accepted = accept(
      fixture.db,
      {
        ...validEvent(),
        connector_id: "kizuki.markdown-folder",
        source_record_id: "acme.md",
        kind: "note",
        text: "Grace runs partnerships at Acme. Reachable at grace@acme.test.",
        subjects: [{ subject_id: "markdown-folder:grace", role: "about", display_name: "grace" }],
        sensitivity_hint: "private",
      },
      { generateId: () => EVENT_ID },
    );
    expect(accepted.status).toBe("stored");

    const worksAt = await draft(
      fixture,
      CLAIM_WORKS_AT,
      "employment.works_at",
      "acme",
      "Works at acme.",
      0.82,
    );
    const email = await draft(
      fixture,
      CLAIM_EMAIL,
      "contact.email",
      "grace@acme.test",
      "Contact: grace@acme.test.",
      0.9,
    );

    const decision = resolveTarget(fixture.io, worksAt);
    expect(decision).toEqual({ action: "create", rel_path: "people/grace.md" });

    const receipt = applyCanonWrite(fixture.io, [worksAt, email], decision, {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });

    const pagePath = join(fixture.vault, "people", "grace.md");
    const bytes = readFileSync(pagePath);
    expect(bytes.toString("utf8")).toBe(EXPECTED_PAGE);
    const afterHash = sha256(new Uint8Array(bytes));
    expect(receipt.after_hash).toBe(afterHash);

    const line = expectedReceipt(afterHash);
    expect(JSON.stringify(receipt)).toBe(line);
    expect(readFileSync(join(fixture.vault, RECEIPTS_PATH), "utf8")).toBe(`${line}\n`);
    expect(JSON.stringify(getCanonReceipt(fixture.db, RECEIPT_ID))).toBe(line);

    for (const claimId of [CLAIM_WORKS_AT, CLAIM_EMAIL]) {
      expect(getClaim(fixture.db, claimId)?.receipt_id).toBe(RECEIPT_ID);
    }
    expect(
      fixture.db
        .query<{ page_id: string; rel_path: string; subject_key: string | null; last_receipt: string | null; last_hash: string }, []>(
          "SELECT page_id, rel_path, subject_key, last_receipt, last_hash FROM page_index",
        )
        .all(),
    ).toEqual([
      {
        page_id: PAGE_ID,
        rel_path: "people/grace.md",
        subject_key: "markdown-folder:grace",
        last_receipt: RECEIPT_ID,
        last_hash: afterHash,
      },
    ]);
    expect(ids).toEqual([]);
  });
});
