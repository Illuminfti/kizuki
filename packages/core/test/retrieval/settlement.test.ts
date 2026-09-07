import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { OWNER } from "../../src/agents";
import { getClaim, insertClaim, markClaimReverted } from "../../src/claims/store";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import { accept, liveEventIds, readLiveEvent, replayLive } from "../../src/ledger/ledger";
import { registerConnection } from "../../src/ledger/connections";
import { bindLocalSourcePort, isLocalSourcePort, setSourceGrant, sourcePolicyEpoch } from "../../src/ledger/source-grants";
import { sourceStoreStatuses } from "../../src/ledger/source-stores";
import { readRetrievalDocuments, rebuildRetrieval } from "../../src/retrieval/rebuild";
import { claimReader } from "../../src/serving/claims";
import { currentQuotedSource, readServableEvents } from "../../src/serving/ledger";
import { listCanonPages } from "../../src/vault/pages";
import { ulid } from "../../src/util/ulid";
import { canonFixture, storeClaim, write, type CanonFixture } from "../canon/helpers";
import { claimInput, FixtureVectorPort } from "../claims/helpers";
import { validEvent } from "../fixtures";

const fixtures: CanonFixture[] = [];
afterEach(() => {
  setSystemTime();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture() {
  const result = canonFixture();
  fixtures.push(result);
  return result;
}
function capture(f: CanonFixture, record: string, order: number, deleted = false, sameTime = false, source?: string) {
  setSystemTime(new Date(Date.UTC(2026, 8, 1, 0, 0, sameTime ? 0 : order)));
  try {
    const result = accept(f.db, {
      ...validEvent(), connector_id: "fixture", source_record_id: record,
      text: deleted ? "" : `Synthetic observation ${order}.`,
      deleted,
    }, {
      generateId: () => String(order).padStart(26, "0"),
      ...(source === undefined ? {} : { source: { source_key: source, expected_revision: 1 } }),
    });
    if (result.status !== "stored") throw new Error(`fixture capture: ${result.status}`);
    return result.event.event_id;
  } finally { setSystemTime(); }
}
async function recorded(f: CanonFixture, event: string, title = "Atlas") {
  const claim = await storeClaim(f.db, event, {
    target: `facts/${title.toLowerCase()}`, subject: `topic:${title.toLowerCase()}`,
    subjects: [], predicate: null, object: null,
    frontmatter: { type: "fact", title }, body: `${title} has a synthetic observation.`,
    producer: "model", model_ref: "fixture:synthetic",
  });
  const receipt = write(f.io, claim);
  return { claim, page: listCanonPages(f.vault).find(page => page.relPath === receipt.page_path)! };
}
class SettlementPort extends FixtureVectorPort {
  readonly removed: string[][] = [];
  readonly checked: string[][] = [];
  afterPublish: () => void | Promise<void> = () => {};
  afterRemove: () => void = () => {};
  afterProof: () => void = () => {};
  async rebuildFromDocuments(docs: readonly RetrievalDoc[]) {
    this.docs.clear();
    await this.upsert(docs);
    await this.afterPublish();
  }
  override async remove(ids: readonly string[]) {
    this.removed.push([...ids]);
    const result = await super.remove(ids);
    this.afterRemove();
    return result;
  }
  override async verifyAbsent(ids: readonly string[]) {
    this.checked.push([...ids]);
    const result = await super.verifyAbsent(ids);
    this.afterProof();
    return result;
  }
}

for (const sameTime of [false, true]) {
  test(`recapture agrees across replay, serving, claims and rebuild (${sameTime ? "ID tie break" : "accepted time"})`, async () => {
    const f = fixture();
    const original = capture(f, "atlas", 1, false, sameTime);
    const tombstone = capture(f, "atlas", 2, true, sameTime);
    const recaptured = capture(f, "atlas", 3, false, sameTime);
    const { claim, page } = await recorded(f, recaptured);
    const ids = [original, tombstone, recaptured, "absent"];
    expect([...replayLive(f.db)].map(event => event.event_id)).toEqual([recaptured]);
    expect([...liveEventIds(f.db, ids)]).toEqual([recaptured]);
    expect(readLiveEvent(f.db, original)).toBeNull();
    expect(readLiveEvent(f.db, recaptured)?.event_id).toBe(recaptured);
    expect(currentQuotedSource(f.db, original)).toBeNull();
    expect(currentQuotedSource(f.db, recaptured)?.event_id).toBe(recaptured);
    expect([...readServableEvents(f.db, ids).keys()]).toEqual([recaptured, `event:${recaptured}`]);
    expect(claimReader(f.db, OWNER.grant).canRead(claim)).toBe(true);
    const port = new SettlementPort();
    const result = await rebuildRetrieval(f.db, f.vault, port);
    expect([...port.docs.keys()].sort()).toEqual([
      `claim:${claim.claim_id}`, `event:${recaptured}`, `page:${page.id}`,
    ].sort());
    expect(result.documents).toBe(3);
    expect(port.removed).toEqual([]);
    expect([...port.docs.values()]).toEqual(readRetrievalDocuments(f.db, f.vault));
  });
}

test("a settled source withdrawal removes its event, claim and recorded page", async () => {
  const f = fixture();
  const event = capture(f, "atlas", 1);
  const { claim, page } = await recorded(f, event);
  const retained = capture(f, "meridian", 2);
  const epoch = sourcePolicyEpoch(f.db);
  const port = new SettlementPort();
  port.afterPublish = () => { capture(f, "atlas", 3, true); };
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("source authorization changed");
  expect(sourcePolicyEpoch(f.db)).toBe(epoch);
  expect(port.removed.flat().sort()).toEqual([`event:${event}`, `claim:${claim.claim_id}`, `page:${page.id}`].sort());
  expect(port.checked).toEqual(port.removed);
  expect([...port.docs.keys()]).toEqual([`event:${retained}`]);
});

test("settlement withdraws an edited page while its original source stays live", async () => {
  const f = fixture();
  const event = capture(f, "atlas", 1);
  const { page } = await recorded(f, event);
  const port = new SettlementPort();
  port.afterPublish = () => writeFileSync(page.path, readFileSync(page.path, "utf8") + "\nOwner annotation.\n");
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("source authorization changed");
  expect(readLiveEvent(f.db, event)).not.toBeNull();
  expect(port.removed).toEqual([[`page:${page.id}`]]);
  expect(port.docs.has(`event:${event}`)).toBe(true);
});

test("each completed cleanup checks remaining claim lifecycle before settlement", async () => {
  const f = fixture();
  const first = capture(f, "atlas", 1);
  const second = capture(f, "meridian", 2);
  const a = await recorded(f, first);
  const b = await recorded(f, second, "Meridian");
  const port = new SettlementPort();
  port.afterPublish = () => writeFileSync(a.page.path, readFileSync(a.page.path, "utf8") + "\nOwner annotation.\n");
  port.afterProof = () => { markClaimReverted(f.db, b.claim.claim_id, new Date().toISOString()); };
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("source authorization changed");
  expect(port.removed).toEqual([[`page:${a.page.id}`], [`claim:${b.claim.claim_id}`]]);
  expect(port.checked).toEqual(port.removed);
  expect(port.docs.has(`page:${b.page.id}`)).toBe(true);
  expect(readLiveEvent(f.db, second)).not.toBeNull();
});

test("a claim revision cannot retain the prior projection through the same live source IDs", async () => {
  const f = fixture();
  const original = capture(f, "atlas", 1);
  const confirmation = capture(f, "meridian", 2);
  const input = claimInput(original, { body: "Atlas works at Meridian.",
    subject: "person:atlas", predicate: "employment.works_at", object: "meridian" });
  const first = await insertClaim({ db: f.db }, input);
  if (first.outcome !== "stored") throw new Error("fixture claim was not stored");
  const before = readRetrievalDocuments(f.db, f.vault).find(doc => doc.kind === "claim");
  const port = new SettlementPort();
  port.afterPublish = async () => {
    const result = await insertClaim({ db: f.db }, { ...input,
      body: "A second observation confirms Atlas works at Meridian.", provenance: [confirmation] });
    expect(result.outcome).toBe("duplicate");
  };
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("source authorization changed");
  expect(getClaim(f.db, first.claim.claim_id)?.corroboration).toBe(2);
  expect(readRetrievalDocuments(f.db, f.vault).find(doc => doc.kind === "claim")).toEqual(before);
  expect(getClaim(f.db, first.claim.claim_id)?.provenance).toEqual([original]);
  expect(port.removed).toEqual([[`claim:${first.claim.claim_id}`]]);
  expect([...liveEventIds(f.db, [original, confirmation])].sort()).toEqual([original, confirmation]);
});

test("settlement cleanup stays within the original corpus and 100-document batches", async () => {
  const f = fixture();
  const ids = Array.from({ length: 101 }, (_, index) => capture(f, "atlas", index + 1));
  const port = new SettlementPort();
  port.afterPublish = () => { capture(f, "atlas", 102, true); };
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("source authorization changed");
  expect(port.removed.map(batch => batch.length)).toEqual([100, 1]);
  expect(port.checked).toEqual(port.removed);
  expect(port.removed.flat().sort()).toEqual(ids.map(id => `event:${id}`).sort());
  expect(port.docs.size).toBe(0);
});

test("unproven cleanup retains the durable source-store obligation and invalidates its capability", async () => {
  const f = fixture();
  const source = ulid();
  registerConnection(f.db, "fixture", source);
  setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: "settlement-fixture", policy: {
    purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  } });
  const event = capture(f, "atlas", 1, false, false, source);
  const port = bindLocalSourcePort(new SettlementPort(), { store_id: "local:settlement" });
  port.afterPublish = () => { capture(f, "atlas", 2, true, false, source); };
  port.verifyAbsent = async ids => ({ ...await FixtureVectorPort.prototype.verifyAbsent.call(port, ids), store: "test.kizuki.retrieval.other" });
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("could not establish absence");
  expect(port.removed).toEqual([[`event:${event}`]]);
  expect(isLocalSourcePort(port)).toBe(false);
  expect(sourceStoreStatuses(f.db, source)).toEqual([{ store_id: "local:settlement", status: "pending" }]);
  expect(f.db.query("SELECT checked FROM source_store_inventory WHERE source_key=?").get(source)).toEqual({ checked: 0 });
});

test("absence is checked against the originally recorded descriptor identity", async () => {
  const f = fixture();
  const event = capture(f, "atlas", 1);
  const port = new SettlementPort();
  port.afterPublish = () => { Object.assign(port.descriptor, { id: "test.kizuki.retrieval.other" }); };
  await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("could not establish absence");
  expect(port.removed).toEqual([[`event:${event}`]]);
});
