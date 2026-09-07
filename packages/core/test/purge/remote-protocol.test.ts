import { afterEach, expect, test } from "bun:test";
import { hashBody } from "../../src/claims/hash";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { isHeld, resumePurge, runPurge } from "../../src/ledger/purge";
import { temporaryPortContext } from "../contracts/fixtures";
import { startRemoteRetrievalFixture } from "../contracts/remote-fixture";
import { validEvent } from "../fixtures";
import { tempVault, writeCanon } from "../helpers/vault";

const AT = "2026-09-06T15:00:00.000Z";
const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

async function remote(proofStore?: string) {
  const fixture = await startRemoteRetrievalFixture(proofStore === undefined ? {} : { proofStore });
  const temporary = temporaryPortContext(fixture.descriptor);
  const port = await fixture.create(temporary.ctx);
  disposers.push(temporary.cleanup, () => fixture.stop(), () => port.close());
  return port;
}

function doc(id: string, provenance: string[]): RetrievalDoc {
  return {
    doc_id: id, kind: id.startsWith("claim:") ? "claim" : "page", title: "Atlas", text: "Ordinary Atlas fixture",
    sensitivity: "personal", taint: "quoted", authority: "connector_evidence", subjects: [], provenance,
    occurred_at: AT, updated_at: AT,
  };
}

test("remote proofs bind authenticated backend identity before mapping to adapter identity", async () => {
  const healthy = await remote();
  expect((await healthy.verifyAbsent(["page:ordinary-missing"])).store).toBe(healthy.descriptor.id);
  expect((await healthy.verifyProvenanceAbsent!(["ordinary-event"])).store).toBe(healthy.descriptor.id);
  const unbound = await remote("kizuki.retrieval.unbound-fixture");
  await expect(unbound.verifyAbsent(["page:ordinary-missing"])).rejects.toThrow("authenticated store");
  await expect(unbound.verifyProvenanceAbsent!(["ordinary-event"])).rejects.toThrow("authenticated store");
});

test("a real remote adapter proves a closure above 10,000 IDs in bounded chunks and retains a late negative proof", async () => {
  const disk = tempVault("kizuki-purge-remote-");
  const db = openLedger(":memory:");
  disposers.push(disk.dispose, () => db.close());
  const stored = accept(db, validEvent());
  if (stored.status !== "stored") throw new Error("ordinary event was not stored");
  const erased = stored.event.event_id;
  const ids: string[] = [];
  const insert = db.query(`INSERT INTO claims
    (claim_id,kind,body,frontmatter,provenance,subjects,producer,confidence,status,created_at,body_hash,sensitivity,taint,valid_from,asserted_at)
    VALUES(?,'claim',?,'{}',?,'[]','deterministic',0.8,'live',?,?,'personal','quoted',?,?)`);
  db.transaction(() => {
    for (let index = 0; index < 10_025; index += 1) {
      const id = `ordinary-${String(index).padStart(5, "0")}`;
      const body = `Atlas fixture ${id}.`;
      insert.run(id, body, JSON.stringify([erased]), AT, hashBody(body), AT, AT);
      ids.push(`claim:${id}`);
    }
  })();
  writeCanon(disk.path, "facts/atlas.md", {
    id: "atlas", title: "Atlas", type: "fact", status: "active", sensitivity: "personal", taint: "quoted", sources: [erased],
  }, "Atlas fixture ordinary-10024.\n");
  const port = await remote();
  const independent = `page:${erased}`;
  await port.upsert([
    doc(ids[0]!, [erased]), doc(ids.at(-1)!, [`event:${erased}`]),
    doc("page:external-raw-copy", [erased]), doc("page:external-prefixed-copy", [`event:${erased}`]), doc(independent, ["ordinary-independent-event"]),
  ]);
  // Preserve the transport's v1 request guard. Purge must compose bounded calls.
  await expect(port.verifyAbsent(ids)).rejects.toThrow();
  const sizes: number[] = [];
  const exactRemove = port.remove.bind(port), exactVerify = port.verifyAbsent.bind(port);
  const provenanceRemove = port.removeByProvenance!.bind(port), provenanceVerify = port.verifyProvenanceAbsent!.bind(port);
  port.remove = async chunk => { sizes.push(chunk.length); return exactRemove(chunk); };
  port.removeByProvenance = async chunk => { sizes.push(chunk.length); return provenanceRemove(chunk); };
  port.verifyProvenanceAbsent = async chunk => { sizes.push(chunk.length); return provenanceVerify(chunk); };
  let negative = true;
  port.verifyAbsent = async chunk => {
    sizes.push(chunk.length);
    const proof = await exactVerify(chunk);
    return negative && chunk.includes(ids.at(-1)!) ? { ...proof, found: [ids.at(-1)!] } : proof;
  };
  const outcome = await runPurge(db, disk.path, { event_id: erased }, "retire ordinary fixture", { retrieval: port, now: () => AT });
  expect(outcome.purge_ops[0]?.ids.length).toBe(ids.length + 2);
  expect(outcome.purge_ops[0]?.state).toBe("pending");
  expect(isHeld(db, "facts/atlas.md")).toBe(true);
  expect(outcome.rewritten).toEqual([]);
  negative = false;
  const complete = await resumePurge(db, disk.path, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
  expect(complete.ok).toBe(true);
  expect(complete.proofs[0]?.checked).toBe(ids.length + 2);
  expect(Math.max(...sizes)).toBe(500);
  expect(sizes.every(size => size > 0 && size <= 500)).toBe(true);
  expect(sizes.filter(size => size === 500).length).toBeGreaterThan(20);
  expect((await exactVerify(["page:external-raw-copy", "page:external-prefixed-copy", ids.at(-1)!])).found).toEqual([]);
  expect((await exactVerify([independent])).found).toEqual([independent]);
  const persisted = db.query<{ proof: string }, []>("SELECT proof FROM purge_ops").get()!;
  expect(JSON.parse(persisted.proof)).toMatchObject({
    schema: "kizuki.purge-proof/v1", checked: ids.length + 2, found: [], store: port.descriptor.id,
    provenance: { scope: "event-provenance/v1", checked: 1, found: [], store: port.descriptor.id },
  });
});
