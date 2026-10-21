import { expect, test } from "bun:test";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { addAgent, authenticate, OWNER, OWNER_AGENT_GRANT } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { accept } from "../../src/ledger/ledger";
import { serveSearch } from "../../src/serving/search";
import { serveTimeline } from "../../src/serving/timeline";
import { serveGetPage } from "../../src/serving/page";
import { serveGraph } from "../../src/serving/graph";
import { serveEntities } from "../../src/serving/entities";
import { serveContextPacketV2 } from "../../src/serving/packet";
import { servePropose } from "../../src/serving/propose";
import { serveCorrect } from "../../src/serving/correct";
import { ENVELOPE_V2_SCHEMA as V2 } from "../../src/serving/types";
import { scopedWriterRefusal } from "../../src/serving/v2/writer-refusal";
import { WRITER_REFUSAL_V2 } from "../../src/contracts/scoped-tools";
import { referenceScope, type RefScope } from "../../src/world/ref-kinds/common";
import { issueClaimRef } from "../../src/world/ref-kinds/claim";
import { issuePageRef, resolvePageRef } from "../../src/world/ref-kinds/page";
import { issueReceiptRef, resolveReceiptRef } from "../../src/world/ref-kinds/receipt";
import { issueRawSubjectRef } from "../../src/world/ref-kinds/raw-subject";
import { tryWriteFlock } from "../../src/serve/flock";
import { worldSeed } from "../helpers/world-seed";
import { recordedPage } from "../helpers/recorded-page";
import { tempVault } from "../helpers/vault";
import { validEvent } from "../fixtures";

async function fixture() {
  const vault = tempVault("kizuki-scoped-tools-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const seed = await worldSeed(db, { subject: "topic:scoped", label: "Scoped evidence", connector: "scoped.fixture", discover: false });
  const other = await worldSeed(db, { subject: "topic:scoped", label: "Other source", connector: "scoped.fixture", discover: false });
  const agent = addAgent(db, "scoped-client", { ...OWNER_AGENT_GRANT, tools: [...OWNER_AGENT_GRANT.tools, "correct"], ceiling: "private", rate_limit_per_minute: 200 });
  const ctx = { db, vaultPath: vault.path, principal: authenticate(db, agent.token)! };
  const owner = { ...ctx, principal: OWNER };
  const page = await recordedPage(db, vault.path, "entities/scoped.md", { id: "page:scoped", title: "Scoped evidence", type: "topic", status: "active", sensitivity: "public", taint: "quoted", subjects: ["topic:scoped"], sources: [seed.eventId] }, "A useful definition. [[Unresolved literal]]", [seed.eventId]);
  const run = <T>(fn: (scope: RefScope) => T, context = ctx) => db.transaction(() => fn(referenceScope(context))).immediate();
  const refs = run(scope => ({ page: issuePageRef(scope, "page:scoped")!, receipt: issueReceiptRef(scope, page.receipt.receipt_id)!, raw: issueRawSubjectRef(scope, { kind: "supplied", id: "topic:scoped", namespace: { connector_id: "scoped.fixture", source_key: seed.sourceKey } })! }));
  return { db, vault, seed, other, ctx, owner, page, refs, run, dispose() { db.close(); vault.dispose(); } };
}
const forbidden = new Set(["page_id", "path", "event_id", "connector_id", "claim_id", "claim_key", "receipt_id", "source_key", "subject_labels", "frontmatter", "epoch"]);
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [...(forbidden.has(key) ? [key] : []), ...keys(child)]);
}
async function refused(work: () => unknown | Promise<unknown>) { try { await work(); throw Error("accepted"); } catch (error) { if (!(error instanceof Error) || error.message === "accepted") throw error; return { code: (error as any).code, message: error.message }; } }

test("scoped read DTOs contain typed identities, exact qualified selection, and no legacy nested fields", async () => {
  const f = await fixture(); try {
    const page = serveGetPage(f.ctx, { page: f.refs.page }, V2);
    expect(page.data).toBeNull(); expect(page.canon[0]!.page).toEqual(f.refs.page);
    const timeline = serveTimeline(f.ctx, { subject: f.refs.raw, limit: 1 }, V2);
    expect(timeline.data).toBeNull(); expect(timeline.quoted).toHaveLength(1);
    expect(timeline.quoted[0]!.subjects).toContainEqual(f.refs.raw);
    expect(timeline.quoted[0]!.source.kind).toBe("source");
    const sourceRead = serveTimeline(f.ctx, { source: timeline.quoted[0]!.source }, V2);
    expect(sourceRead.quoted.map(q => q.eventVersion)).toEqual(timeline.quoted.map(q => q.eventVersion));
    const entities = serveEntities(f.ctx, { type: "topic" }, V2);
    const graph = await serveGraph(f.ctx, { anchor: f.refs.page, depth: 1 }, V2);
    expect(graph.data.edges).toContainEqual({ kind: "wikilink", from: f.refs.page, to: { kind: "unresolved", text: "Unresolved literal", quoted: true } });
    const search = await serveSearch(f.ctx, { query: "Scoped", subjects: [f.refs.raw] }, V2);
    for (const output of [page, timeline, sourceRead, entities, graph, search]) expect(keys(output)).toEqual([]);
    expect(Object.keys(search.data)).toEqual(["gaps"]);
    const legacy = serveGetPage(f.owner, { id: "page:scoped" });
    expect(legacy.canon[0]!.page_id).toBe("page:scoped");
    expect(legacy.canon[0]!.path).toBe("entities/scoped.md");
    expect(legacy).toHaveProperty("denied");
  } finally { f.dispose(); }
}, 120_000);

test("scoped inputs refuse raw IDs, wrong kind, wrong namespace, malformed refs and accessors without executing them", async () => {
  const f = await fixture(); try {
    expect((await refused(() => serveGetPage(f.ctx, { id: "page:scoped" }, V2))).code).toBe("invalid_arguments");
    const absent = { kind: "page", token: "A".repeat(43) } as const;
    const unknown = await refused(() => serveGetPage(f.ctx, { page: absent }, V2));
    expect(await refused(() => serveGetPage(f.ctx, { page: f.refs.raw as any }, V2))).toEqual(unknown);
    expect(await refused(() => serveGetPage(f.owner, { page: f.refs.page }, V2))).toEqual(unknown);
    let calls = 0; const input = Object.defineProperty({}, "page", { enumerable: true, get() { calls++; return f.refs.page; } });
    expect((await refused(() => serveGetPage(f.ctx, input as any, V2))).code).toBe("invalid_arguments");
    expect(calls).toBe(0);
    expect((await refused(() => serveGetPage(f.ctx, { page: { ...absent, token: "!" } }, V2))).code).toBe("invalid_arguments");
    revokeSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: 1, operation_id: "scoped-revoke" });
    expect(await refused(() => serveGetPage(f.ctx, { page: f.refs.page }, V2))).toEqual(unknown);
  } finally { f.dispose(); }
}, 120_000);

test("packet refs are rendered before budgeting while literal ID-looking captured text stays quoted", async () => {
  const f = await fixture(); try {
    const literal = "page_id: entities/scoped.md event_id: literal-not-an-identifier";
    const captured = accept(f.db, { ...validEvent(), connector_id: "scoped.fixture", source_record_id: "literal-text", text: literal, sensitivity_hint: "public", subjects: [{ subject_id: "topic:scoped", role: "about" }] }, { source: { source_key: f.seed.sourceKey, expected_revision: 1 } });
    expect(captured.status).toBe("stored");
    const packet = await serveContextPacketV2(f.ctx, { purpose: "recall", subjects: [f.refs.raw], since: "2020-01-01T00:00:00Z", until: "2040-01-01T00:00:00Z", budget_tokens: 2000 });
    const result = packet.data.result; if (!("data" in result)) throw Error("no packet");
    expect(Object.keys(result.data).sort()).toEqual(["budgetTokens", "coverage", "packetMd", "purpose", "tokenizer", "tokens"]);
    expect(result.data.tokens).toBeLessThanOrEqual(2000);
    expect(result.data.packetMd).toContain("[event-version-ref:");
    expect(result.data.packetMd).toContain(`> ${literal}`);
    expect(result.data.packetMd).not.toContain(f.seed.eventId);
    expect(result.data.packetMd).not.toContain(f.seed.sourceKey);
    expect(keys(packet)).toEqual([]);
    expect((await refused(() => serveContextPacketV2(f.ctx, { budget_tokens: 50 }))).code).toBe("invalid_arguments");
    for (const budget_tokens of [150, 250]) {
      const small = (await serveContextPacketV2(f.ctx, { purpose: "recall", budget_tokens })).data.result;
      if ("data" in small) expect(small.data.tokens).toBeLessThanOrEqual(budget_tokens);
    }
  } finally { f.dispose(); }
}, 120_000);

test("typed propose resolves only current principal refs and preserves literals without flattening rich objects", async () => {
  const f = await fixture(); try {
    const q = serveTimeline(f.ctx, { subject: f.refs.raw }, V2).quoted[0]!;
    const input = { kind: "claim" as const, subject: f.refs.raw, provenance: [q.eventVersion], body: "A scoped claim", predicate: "preference.prefers", object: { kind: "literal" as const, value: "literal page:scoped" } };
    const before = f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims").get()!.n;
    const rich = await refused(() => servePropose(f.ctx, { ...input, object: { kind: "node", ref: { kind: "object", token: "A".repeat(43) } } }, V2));
    expect(rich.code).toBe("invalid_arguments");
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims").get()!.n).toBe(before);
    const output = await servePropose(f.ctx, input, V2);
    expect(output.data.claim.kind).toBe("claim"); expect(keys(output)).toEqual([]);
    const row = f.db.query<{ object: string }, [string]>("SELECT object FROM claims WHERE body=?").get(input.body);
    expect(row?.object).toBe(input.object.value);
    const duplicate = await servePropose(f.ctx, input, V2);
    expect(duplicate.data.claim).toEqual(output.data.claim);
    expect(duplicate.data.outcome).toBe("duplicate");
    const corrected = await serveCorrect(f.ctx, { statement: "A reviewed preference.", target: output.data.claim, object: { kind: "literal", value: "reviewed" } }, V2);
    expect(corrected.data.message).toBe("correction_recorded");
    expect(corrected.data.superseded).toEqual([output.data.claim]);
    revokeSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: 1, operation_id: "stale-proposal" });
    expect((await refused(() => servePropose(f.ctx, input, V2))).code).toBe("not_found");
  } finally { f.dispose(); }
}, 120_000);

test("page tokens expire on exact byte changes and receipt attribution loses source authority", async () => {
  const f = await fixture(); try {
    expect(f.refs.receipt).not.toBeNull();
    expect(f.run(scope => resolveReceiptRef(scope, f.refs.receipt))?.receipt_id).toBe(f.page.receipt.receipt_id);
    appendFileSync(join(f.vault.path, "entities/scoped.md"), "\nOwner addition.\n");
    expect(f.run(scope => resolvePageRef(scope, f.refs.page))).toBeNull();
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(f.refs.page.token)).toBeNull();
    revokeSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: 1, operation_id: "receipt-source-lost" });
    expect(f.run(scope => resolveReceiptRef(scope, f.refs.receipt))).toBeNull();
  } finally { f.dispose(); }
}, 120_000);

test("ordinary writer contention refuses before mutation with the fixed scoped payload", async () => {
  const f = await fixture(); try {
    const target = f.run(scope => issueClaimRef(scope, f.seed.claims.at(-1)!)!, f.owner);
    const before = f.db.query("SELECT event_id FROM events ORDER BY event_id").all();
    const lock = tryWriteFlock(f.vault.path); if (lock === null) throw Error("fixture lock unavailable");
    try {
      let error: unknown; try { await serveCorrect(f.owner, { statement: "New definition", target }, V2); } catch (caught) { error = caught; }
      expect(scopedWriterRefusal(error)).toEqual(WRITER_REFUSAL_V2);
      expect(f.db.query("SELECT event_id FROM events ORDER BY event_id").all()).toEqual(before);
    } finally { lock.release(); }
  } finally { f.dispose(); }
}, 120_000);


test("a scoped proposal rechecks reference authority after asynchronous preparation", async () => {
  const f = await fixture(); try {
    const q = serveTimeline(f.ctx, { subject: f.refs.raw }, V2).quoted[0]!;
    const count = f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims").get()!.n;
    const pending = servePropose(f.ctx, { kind: "claim", body: "A separate scoped proposal", subject: f.refs.raw, provenance: [q.eventVersion], predicate: "preference.prefers", object: { kind: "literal", value: "reviewed" } }, V2);
    revokeSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: 1, operation_id: "revoke-during-scoped-prepare" });
    expect((await refused(() => pending)).code).toBe("not_found");
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims").get()!.n).toBe(count);
  } finally { f.dispose(); }
}, 120_000);

test("pending erasure refuses scoped writes with the contention payload while existing read refs stay usable", async () => {
  const f = await fixture(); try {
    const q = serveTimeline(f.ctx, { subject: f.refs.raw }, V2).quoted[0]!;
    const target = f.run(scope => issueClaimRef(scope, f.seed.claims[2]!)!);
    const counts = () => ["events", "claims", "canon_receipts", "native_owner_evidence"].map(table => f.db.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()!.n);
    const before = counts();
    f.db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("private-unrelated", "private-source", "private-recovery", "private-digest");
    for (const work of [
      () => servePropose(f.ctx, { kind: "claim", body: "Unavailable proposal", provenance: [q.eventVersion] }, V2),
      () => serveCorrect(f.ctx, { statement: "The corrected definition.", target }, V2),
    ]) {
      const error = await work().catch(error => error);
      expect(scopedWriterRefusal(error)).toEqual(WRITER_REFUSAL_V2);
      expect(counts()).toEqual(before);
    }
    expect(serveGetPage(f.ctx, { page: f.refs.page }, V2).canon[0]!.page).toEqual(f.refs.page);
    expect(serveTimeline(f.ctx, { eventVersion: q.eventVersion }, V2).quoted[0]!.eventVersion).toEqual(q.eventVersion);
  } finally { f.dispose(); }
}, 120_000);
