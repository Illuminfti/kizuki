import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget } from "../../src/canon/arbiter";
import { UndoError } from "../../src/canon/errors";
import { getCanonReceipt, listCanonReceipts } from "../../src/canon/receipts";
import { undoReceipt } from "../../src/canon/undo";
import { getClaim } from "../../src/claims/store";
import { ABSENT_PAGE_HASH } from "../../src/vault/write";
import { FixtureVectorPort } from "../claims/helpers";
import { corroboratedFacts } from "../claims/helpers";
import {
  canonFixture,
  putEvent,
  readBytes,
  sha256,
  storeClaim,
  write,
} from "./helpers";
import type { CanonFixture } from "./helpers";

const fixtures: CanonFixture[] = [];

function fixture(overrides: Parameters<typeof canonFixture>[0] = {}): CanonFixture {
  const created = canonFixture(overrides);
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

function twoSources(db: CanonFixture["db"]) {
  const first = putEvent(db, { connector_id: "fixture" });
  const second = putEvent(db, { connector_id: "other-fixture" });
  return { ids: [first, second], events: corroboratedFacts(first, second) };
}

function code(error: unknown): string {
  return error instanceof UndoError ? error.code : String(error);
}

async function attempt(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
}

describe("undoReceipt", () => {
  test("undo of a create deletes the page and reverts its claims", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    const receipt = write(io, claim);
    const path = join(vault, receipt.page_path);
    expect(existsSync(path)).toBe(true);
    expect(getClaim(db, claim.claim_id)?.status).toBe("live");
    expect(getClaim(db, claim.claim_id)?.receipt_id).toBe(receipt.receipt_id);

    const revert = await undoReceipt(io, receipt.receipt_id);
    expect(revert.kind).toBe("revert");
    expect(revert.reverts).toBe(receipt.receipt_id);
    expect(revert.writer).toBe("revert");
    expect(revert.before_hash).toBe(receipt.after_hash);
    expect(revert.after_hash).toBe(ABSENT_PAGE_HASH);
    expect(existsSync(path)).toBe(false);
    expect(getClaim(db, claim.claim_id)?.status).toBe("reverted");
    expect(getCanonReceipt(db, receipt.receipt_id)?.reverted_by).toBe(revert.receipt_id);
    expect(listCanonReceipts(db).map((row) => row.kind)).toEqual(["write", "revert"]);
  });

  test("undo of an edit restores the exact prior bytes", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const path = join(vault, created.page_path);
    const prior = readBytes(vault, created.page_path);
    const priorHash = sha256(prior);

    const edited = write(
      io,
      await storeClaim(db, eventId, {
        kind: "edit",
        predicate: null,
        object: null,
        body: "Grace leads partnerships at Acme.",
        frontmatter: { title: "Grace (Acme)" },
      }),
    );
    expect(readFileSync(path, "utf8")).toContain("leads partnerships");
    expect(edited.before_hash).toBe(priorHash);
    expect(edited.archive_path).not.toBeNull();

    const revert = await undoReceipt(io, edited.receipt_id);
    const restored = readBytes(vault, created.page_path);
    expect(sha256(restored)).toBe(priorHash);
    expect(revert.after_hash).toBe(priorHash);
    expect(readFileSync(path, "utf8")).toBe(Buffer.from(prior).toString("utf8"));
  });

  test("undo refuses when the page changed since the receipt", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const path = join(vault, created.page_path);
    writeFileSync(path, `${readFileSync(path, "utf8")}\nHand edit.\n`);

    const refused = await attempt(() => undoReceipt(io, created.receipt_id));
    expect(refused).toBeInstanceOf(UndoError);
    expect(code(refused)).toBe("page_changed");
    expect(String(refused)).toContain(`page changed since receipt ${created.receipt_id}`);
    expect(existsSync(path)).toBe(true);
    expect(getCanonReceipt(db, created.receipt_id)?.reverted_by).toBeNull();
  });

  test("undo refuses a receipt that is already reverted", async () => {
    const { db, io } = fixture();
    const created = write(io, await storeClaim(db, putEvent(db)));
    const already = await undoReceipt(io, created.receipt_id);
    expect(already.kind).toBe("revert");
    const again = await attempt(() => undoReceipt(io, created.receipt_id));
    expect(code(again)).toBe("already_reverted");
    expect(String(again)).toContain(`already reverted by ${already.receipt_id}`);
  });

  test("undo --cascade reverts later receipts newest first", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const edited = write(
      io,
      await storeClaim(db, eventId, {
        kind: "edit",
        predicate: null,
        object: null,
        body: "Grace leads partnerships at Acme.",
        frontmatter: {},
      }),
    );
    const path = join(vault, created.page_path);
    expect(readFileSync(path, "utf8")).toContain("leads partnerships");

    const refused = await attempt(() => undoReceipt(io, created.receipt_id));
    expect(code(refused)).toBe("page_changed");
    expect(String(refused)).toContain(edited.receipt_id);

    const revert = await undoReceipt(io, created.receipt_id, { cascade: true });
    expect(existsSync(path)).toBe(false);
    expect(getCanonReceipt(db, edited.receipt_id)?.reverted_by).not.toBeNull();
    expect(getCanonReceipt(db, created.receipt_id)?.reverted_by).not.toBeNull();
    expect(revert.reverts).toBe(created.receipt_id);
  });

  test("undo reinstates superseded claims with their prior validity", async () => {
    const { db, io } = fixture();
    const sources = twoSources(db);
    const live = await storeClaim(db, sources.ids[0] as string, {
      provenance: sources.ids,
      events: sources.events,
      confidence: 0.6,
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: "2026-12-31T00:00:00Z",
    });
    write(io, live);
    const priorTo = getClaim(db, live.claim_id)?.valid_to;

    const incoming = await storeClaim(db, sources.ids[0] as string, {
      provenance: sources.ids,
      events: sources.events,
      object: "initech",
      body: "Grace moved to partnerships lead at Initech.",
      confidence: 0.9,
      valid_from: "2026-07-01T00:00:00Z",
    });
    expect(getClaim(db, live.claim_id)?.status).toBe("superseded");
    const receipt = write(io, incoming, { decision: resolveTarget(io, incoming) });
    expect(receipt.superseded).toEqual([
      { claim_id: live.claim_id, claim_key: live.claim_key as string },
    ]);

    await undoReceipt(io, receipt.receipt_id);
    const restored = getClaim(db, live.claim_id);
    expect(restored?.status).toBe("live");
    expect(restored?.superseded_by).toBeNull();
    expect(restored?.retracted_at).toBeNull();
    expect(restored?.valid_to).toBe(priorTo);
    expect(getClaim(db, incoming.claim_id)?.status).toBe("reverted");
  });

  test("undo of an undo restores the write", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    const created = write(io, claim);
    const prior = readBytes(vault, created.page_path);
    const revert = await undoReceipt(io, created.receipt_id);
    expect(existsSync(join(vault, created.page_path))).toBe(false);

    const restored = await undoReceipt(io, revert.receipt_id);
    expect(restored.reverts).toBe(revert.receipt_id);
    expect(existsSync(join(vault, created.page_path))).toBe(true);
    expect(sha256(readBytes(vault, created.page_path))).toBe(sha256(prior));
    expect(getClaim(db, claim.claim_id)?.status).toBe("live");
    expect(getCanonReceipt(db, revert.receipt_id)?.reverted_by).toBe(restored.receipt_id);
  });

  test("undo removes the added retrieval documents and proves absence", async () => {
    const retrieval = new FixtureVectorPort();
    const { db, io, vault } = fixture({
      retrieval_store: retrieval.descriptor.id,
      retrieval,
    });
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    const receipt = write(io, claim);
    expect(receipt.retrieval_ops).toEqual([
      { store: retrieval.descriptor.id, op: "upsert", doc: expect.stringMatching(/^page:/) },
    ]);
    const docId = receipt.retrieval_ops[0]?.doc as string;
    const page = readFileSync(join(vault, receipt.page_path), "utf8");
    await retrieval.upsert([
      {
        doc_id: docId,
        kind: "page",
        title: "Grace",
        text: page,
        sensitivity: "personal",
        taint: "clean",
        authority: "connector_evidence",
        subjects: ["person:grace"],
        provenance: claim.provenance,
        occurred_at: null,
        updated_at: receipt.at,
      },
    ]);
    expect(retrieval.docs.has(docId)).toBe(true);

    const revert = await undoReceipt(io, receipt.receipt_id);
    expect(retrieval.docs.has(docId)).toBe(false);
    expect(revert.retrieval_ops).toEqual([
      { store: retrieval.descriptor.id, op: "remove", doc: docId },
    ]);
    const proof = await retrieval.verifyAbsent([docId]);
    expect(proof.found).toEqual([]);
    expect(proof.checked).toBe(1);
  });

  test("undo of an edit re-upserts the restored page instead of dropping it", async () => {
    const retrieval = new FixtureVectorPort();
    const { db, io, vault } = fixture({
      retrieval_store: retrieval.descriptor.id,
      retrieval,
    });
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const prior = readFileSync(join(vault, created.page_path), "utf8");
    const docId = created.retrieval_ops[0]?.doc as string;
    await retrieval.upsert([
      {
        doc_id: docId,
        kind: "page",
        title: "Grace",
        text: prior,
        sensitivity: "personal",
        taint: "clean",
        authority: "connector_evidence",
        subjects: [],
        provenance: created.provenance,
        occurred_at: null,
        updated_at: created.at,
      },
    ]);

    const edited = write(
      io,
      await storeClaim(db, eventId, {
        kind: "edit",
        predicate: null,
        object: null,
        body: "Grace leads partnerships at Acme.",
        frontmatter: { title: "Grace (Acme)" },
      }),
    );
    await retrieval.upsert([
      {
        doc_id: docId,
        kind: "page",
        title: "Grace (Acme)",
        text: readFileSync(join(vault, edited.page_path), "utf8"),
        sensitivity: "personal",
        taint: "clean",
        authority: "connector_evidence",
        subjects: [],
        provenance: edited.provenance,
        occurred_at: null,
        updated_at: edited.at,
      },
    ]);

    const revert = await undoReceipt(io, edited.receipt_id);
    expect(retrieval.docs.has(docId)).toBe(true);
    expect(retrieval.docs.get(docId)?.text).toContain("runs partnerships");
    expect(retrieval.docs.get(docId)?.text).not.toContain("leads partnerships");
    expect(revert.retrieval_ops).toEqual([
      { store: retrieval.descriptor.id, op: "upsert", doc: docId },
    ]);
    expect(retrieval.docs.get(docId)?.sensitivity).toBe(created.sensitivity);
    expect(retrieval.docs.get(docId)?.taint).toBe(created.taint);
    expect(retrieval.docs.get(docId)?.authority).toBe(created.authority);
    expect(retrieval.docs.get(docId)?.provenance).toEqual(created.provenance);
  });

  test("a retrieval failure after bytes restore can be retried", async () => {
    let blows = 1;
    const retrieval = new FixtureVectorPort();
    const originalRemove = retrieval.remove.bind(retrieval);
    retrieval.remove = async (ids) => {
      if (blows > 0) {
        blows -= 1;
        throw new Error("retrieval down");
      }
      return originalRemove(ids);
    };

    const { db, io, vault } = fixture({
      retrieval_store: retrieval.descriptor.id,
      retrieval,
    });
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    const receipt = write(io, claim);
    const docId = receipt.retrieval_ops[0]?.doc as string;
    await retrieval.upsert([
      {
        doc_id: docId,
        kind: "page",
        title: "Grace",
        text: readFileSync(join(vault, receipt.page_path), "utf8"),
        sensitivity: "personal",
        taint: "clean",
        authority: "connector_evidence",
        subjects: [],
        provenance: claim.provenance,
        occurred_at: null,
        updated_at: receipt.at,
      },
    ]);

    const first = await attempt(() => undoReceipt(io, receipt.receipt_id));
    expect(first).toBeInstanceOf(Error);
    expect(String(first)).toContain("retrieval down");
    expect(existsSync(join(vault, receipt.page_path))).toBe(false);
    expect(getCanonReceipt(db, receipt.receipt_id)?.reverted_by).toBeNull();

    const revert = await undoReceipt(io, receipt.receipt_id);
    expect(revert.kind).toBe("revert");
    expect(revert.archive_path).not.toBeNull();
    expect(getCanonReceipt(db, receipt.receipt_id)?.reverted_by).toBe(revert.receipt_id);
    expect(retrieval.docs.has(docId)).toBe(false);

    const restored = await undoReceipt(io, revert.receipt_id);
    expect(existsSync(join(vault, receipt.page_path))).toBe(true);
    expect(restored.reverts).toBe(revert.receipt_id);
  });

  test("concurrent undo of the same receipt writes one revert", async () => {
    const { db, io } = fixture();
    const created = write(io, await storeClaim(db, putEvent(db)));
    const results = await Promise.allSettled([
      undoReceipt(io, created.receipt_id),
      undoReceipt(io, created.receipt_id),
    ]);
    const fulfilled = results.filter((row) => row.status === "fulfilled");
    const rejected = results.filter((row) => row.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(listCanonReceipts(db).filter((row) => row.kind === "revert")).toHaveLength(1);
    expect(getCanonReceipt(db, created.receipt_id)?.reverted_by).not.toBeNull();
  });

  test("undo of a revert restores the original supersession window", async () => {
    const { db, io } = fixture();
    const sources = twoSources(db);
    const live = await storeClaim(db, sources.ids[0] as string, {
      provenance: sources.ids,
      events: sources.events,
      confidence: 0.6,
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: "2026-12-31T00:00:00Z",
    });
    write(io, live);

    const incoming = await storeClaim(db, sources.ids[0] as string, {
      provenance: sources.ids,
      events: sources.events,
      object: "initech",
      body: "Grace moved to partnerships lead at Initech.",
      confidence: 0.9,
      valid_from: "2026-07-01T00:00:00Z",
    });
    const receipt = write(io, incoming, { decision: resolveTarget(io, incoming) });
    const afterWrite = getClaim(db, live.claim_id);
    expect(afterWrite?.status).toBe("superseded");
    expect(afterWrite?.valid_to).toBe("2026-07-01T00:00:00Z");

    const revert = await undoReceipt(io, receipt.receipt_id);
    expect(getClaim(db, live.claim_id)?.valid_to).toBe("2026-12-31T00:00:00Z");

    await undoReceipt(io, revert.receipt_id);
    const again = getClaim(db, live.claim_id);
    expect(again?.status).toBe("superseded");
    expect(again?.superseded_by).toBe(incoming.claim_id);
    expect(again?.valid_to).toBe(afterWrite?.valid_to);
    expect(getClaim(db, incoming.claim_id)?.status).toBe("live");
  });

  test("unknown receipts and import writes without an archive refuse precisely", async () => {
    const { io, db } = fixture();
    const unknown = await attempt(() => undoReceipt(io, "01JCUNKNOWNRECEIPT0000000000"));
    expect(code(unknown)).toBe("receipt_unknown");

    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const edited = write(
      io,
      await storeClaim(db, eventId, {
        kind: "edit",
        predicate: null,
        object: null,
        body: "Rewritten.",
        frontmatter: {},
      }),
    );
    db.query("UPDATE canon_receipts SET archive_path = NULL WHERE receipt_id = ?").run(
      edited.receipt_id,
    );
    const refused = await attempt(() => undoReceipt(io, edited.receipt_id));
    expect(code(refused)).toBe("not_undoable");
    expect(String(refused)).toContain("no archive copy exists");
    expect(getCanonReceipt(db, created.receipt_id)?.reverted_by).toBeNull();
  });
});
