import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { checkNoninterference, HIDDEN_MUTATIONS } from "../helpers/noninterference";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { addAgent, authenticate } from "../../src/agents";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import type { SliceItem } from "../../src/contracts/world-slice";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveContextPacket, serveContextPacketV2 } from "../../src/serving/packet";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import { collectReadFrames, WORLD_CLAIM_VERIFICATION_LIMIT } from "../../src/world/pipeline/frame";
import { compileRecallSlice } from "../../src/world/slice/recall";
import { budget } from "../canon/helpers";
import { cardFixture } from "./card-fixture";

beforeEach(() => setSystemTime(new Date("2026-10-21T12:00:00.000Z")));
afterEach(() => setSystemTime());

const purposes = ["capture", "derive", "recall", "session", "export", "correction"] as const;
const args = { purpose: "recall", query: "Launch", budget_tokens: 2000 } as const;
const items = (body: string): SliceItem[] => body.split("\n").filter(line => line.includes(" :: slice ")).map(line => JSON.parse(line.split(" :: slice ")[1]!));
async function fixture() {
  const f = await cardFixture(undefined, { purposes: [...purposes] });
  const subject = "project:launch";
  await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject });
  await f.write("situation.label", { kind: "literal", value: "Launch" }, { subject });
  await f.write("situation.blocker", { kind: "literal", value: "Current independent review required." }, { subject, mode: "reported", speaker: "person:ada", polarity: "negative" });
  return f;
}

test("recall retains complete current qualifiers and evidence, never expired or future relations", async () => {
  const f = await fixture();
  try {
    await f.write("situation.blocker", { kind: "literal", value: "Obsolete permit required." }, { subject: "project:launch", until: "2026-01-02T00:00:00.000Z" });
    await f.write("situation.blocker", { kind: "literal", value: "Future permit required." }, { subject: "project:launch", from: "2099-01-01T00:00:00.000Z" });
    const response = await serveContextPacketV2(f.ctx, args);
    if (!response.data || !("data" in response.data.result)) throw new Error("packet missing");
    const packet = response.data.result.data, relation = items(packet.packetMd).find(item => item.relation.predicate === "situation.blocker")!;
    expect(relation).toBeDefined();
    expect(relation.relation).toMatchObject({ polarity: "negative", perspective: { mode: "reported", interpretation: "explicit", speaker: { kind: "object" } } });
    expect(relation.evidence.length).toBeGreaterThan(0);
    expect(relation.relation.valid).toEqual({ kind: "known", from: "2026-01-01T00:00:00.000Z", until: null });
    expect(packet.packetMd).not.toContain("Obsolete permit"); expect(packet.packetMd).not.toContain("Future permit");
    expect(packet.tokens).toBe(packetTokens(packet.packetMd)); expect(packet.tokens).toBeLessThanOrEqual(2000);
    const narrow = await serveContextPacketV2(f.ctx, { ...args, budget_tokens: 450 });
    if (!narrow.data || !("data" in narrow.data.result)) throw new Error("packet missing");
    expect(items(narrow.data.result.data.packetMd)).toEqual([]);
    expect(narrow.data.result.status).toBe("incomplete");
    expect(narrow.data.result.data.coverage.gaps).toContain("required_context_overflow");
    expect(narrow.data.result.data.tokens).toBeLessThanOrEqual(450);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "recall-revoke" });
    const revoked = await serveContextPacketV2(f.ctx, args);
    expect(JSON.stringify(revoked)).not.toContain("Current independent review");
  } finally { f.dispose(); }
}, 120000);

test("recall scopes before card limits, needs the typed grant, and honors explicit includes", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const subject = `project:private-${i}`;
      await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject, floor: "private" });
      await f.write("situation.label", { kind: "literal", value: "Launch" }, { subject, floor: "private" });
      await f.write("situation.blocker", { kind: "literal", value: `Private boundary ${i}.` }, { subject, floor: "private" });
    }
    const enrolled = addAgent(f.db, "recall-reader", { ceiling: "public", subjects: ["project:launch", "person:ada"], types: null,
      tools: ["context_packet", "world_view"], rate_limit_per_minute: 1000, relay_owner_corrections: false });
    const principal = authenticate(f.db, enrolled.token)!;
    const response = await serveContextPacket({ ...f.ctx, principal }, { ...args, subjects: ["project:launch"] });
    expect(response.data?.packet_md).toContain("Current independent review required.");
    expect(response.data?.packet_md).not.toContain("Private boundary");
    const explicit = await serveContextPacket(f.ctx, { ...args, include: ["timeline"] });
    expect(items(explicit.data!.packet_md)).toEqual([]);
    const denied = addAgent(f.db, "capture-reader", { ...principal.grant, tools: ["context_packet"] });
    const noWorld = await serveContextPacket({ ...f.ctx, principal: authenticate(f.db, denied.token)! }, args);
    expect(items(noWorld.data!.packet_md)).toEqual([]);
    const scoped = await serveContextPacket(f.ctx, { ...args, subjects: ["topic:bayes"] });
    expect(items(scoped.data!.packet_md)).toEqual([]);
  } finally { f.dispose(); }
}, 120000);

test("Concept recall reaches a definition beyond a long canon prefix as a whole qualified unit", async () => {
  const f = await cardFixture(undefined, { purposes: [...purposes] });
  try {
    const label = await f.write("concept.label", { kind: "literal", value: "Bayesian extended label ".repeat(10).trim() });
    const later = await f.write("concept.definition", { kind: "literal", value: "Update a prior from likelihood evidence." });
    if (label.stored.outcome !== "stored" || later.stored.outcome !== "stored") throw new Error("fixture not stored");
    applyCanonWrite({ db: f.db, vault_path: f.ctx.vaultPath }, [label.stored.claim, later.stored.claim],
      worldCanonTarget(f.db, label.stored.claim.claim_id), { writer: "loop", budget: budget() });
    const target = worldCanonTarget(f.db, label.stored.claim.claim_id);
    if (!("rel_path" in target)) throw new Error("typed target missing");
    const body = parseFrontmatter(readFileSync(join(f.ctx.vaultPath, target.rel_path), "utf8")).body;
    expect(body.indexOf("Update a prior from likelihood evidence.")).toBeGreaterThan(600);
    const response = await serveContextPacketV2(f.ctx, { ...args, query: "Bayesian" });
    if (!response.data || !("data" in response.data.result)) throw new Error("packet missing");
    const definition = items(response.data.result.data.packetMd).find(item => item.relation.predicate === "concept.definition" && item.relation.object.kind === "literal" && item.relation.object.value === "Update a prior from likelihood evidence.")!;
    expect(definition.relation.object).toEqual({ kind: "literal", value: "Update a prior from likelihood evidence." });
    expect(definition.evidence.length).toBeGreaterThan(0);
    expect(response.data.result.data.tokens).toBeLessThanOrEqual(2000);
  } finally { f.dispose(); }
}, 120000);

test("recall shares the existing world verification allowance and preserves an honest partial result", async () => {
  const f = await fixture();
  try {
    const ctx = { ...f.ctx, worldReadBudget: { bytes: 0, claimVerifications: WORLD_CLAIM_VERIFICATION_LIMIT } };
    const { result, frames } = collectReadFrames(() => compileRecallSlice(ctx, { at: new Date().toISOString(), header: "", budgetTokens: 2000, query: "Launch" }));
    expect(result.degraded).toContain("traversal_limit");
    expect(result.truncated).toBe(true);
    expect(result.pieces).toEqual([]);
    expect(frames.every(frame => frame.budget === ctx.worldReadBudget)).toBe(true);
    expect(ctx.worldReadBudget.claimVerifications).toBe(WORLD_CLAIM_VERIFICATION_LIMIT);
  } finally { f.dispose(); }
}, 120000);

for (const mutation of HIDDEN_MUTATIONS.slice(0, 3)) test(`recall bytes and work remain unchanged under ${mutation.name}`, async () => {
  expect(await checkNoninterference({ mutations: [mutation], cases: () => [{ name: "typed recall", run: ctx =>
    serveContextPacketV2(ctx, { ...args, query: "Bayesian" }) }] })).toEqual([]);
}, 120000);

test("revocation after whole-unit projection wins at final public publication", async () => {
  const f = await fixture();
  try {
    let changed = false;
    const db = new Proxy(f.db, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "transaction") return (run: () => unknown) => {
        const tx = target.transaction(run), finish = (result: unknown) => {
          if (!changed && !target.inTransaction && result !== null && typeof result === "object" && "world" in result && "pieces" in result) {
            changed = true;
            revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "recall-publication-revoke" });
          }
          return result;
        };
        return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()) });
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Database;
    await expect(serveContextPacketV2({ ...f.ctx, db }, args)).rejects.toThrow("authorized evidence changed during request");
    expect(changed).toBe(true);
  } finally { f.dispose(); }
}, 120000);

test("explicit historical recall windows do not prepend current typed relations", async () => {
  const f = await fixture();
  try {
    for (const window of [{ until: "2026-01-02T00:00:00.000Z" }, { since: "2026-10-21T11:00:00.000Z" }]) {
      const response = await serveContextPacket(f.ctx, { ...args, ...window });
      expect(items(response.data!.packet_md)).toEqual([]);
      expect(response.data!.packet_md).not.toContain("Current independent review required.");
    }
  } finally { f.dispose(); }
}, 120000);
