import { expect, test } from "bun:test";
import { serveWorldView, readWorldView } from "@kizuki/core/world";
import { cardFixture } from "./card-fixture";
import { OWNER_AGENT_GRANT, addAgent, authenticate, setGrant } from "../../src/agents";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { observe, checkNoninterference } from "../helpers/noninterference";
import { sha256Hex } from "../../src/util/hash";

const ABSENT = { kind: "admission", token: Buffer.alloc(32, 9).toString("base64url") } as const;

test("evidence text travels only in the untrusted quoted channel with an integrity pin", async () => {
  const f = await cardFixture();
  try {
    const evidence = f.card().definitions[0]!.assessments[0]!.evidence[0]!;
    const input = f.input("evidence", { evidence });
    const envelope = serveWorldView(f.ctx, input);
    expect(envelope.quoted).toHaveLength(1);
    expect(envelope.quoted[0]).toMatchObject({ text: f.definition.event.text, tainted: true, evidence });
    expect(envelope.quoted[0]).toHaveProperty("integrity");
    expect(JSON.stringify(envelope.data)).not.toContain(f.definition.event.text);
    expect(envelope.canon).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain(f.definition.event.event_id);
    expect(readWorldView(f.ctx, input)).toEqual(envelope.data);
  } finally { f.dispose(); }
});

test("evidence refs authorize the complete current support; absent, other-principal and revoked refs are identical", async () => {
  const f = await cardFixture();
  try {
    const ownerEvidence = f.card().definitions[0]!.assessments[0]!.evidence[0]!;
    const agent = addAgent(f.db, "evidence-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const evidence = f.card(reader).definitions[0]!.assessments[0]!.evidence[0]!;
    const absent = { ...evidence, admission: ABSENT };
    const read = (target: typeof evidence) => serveWorldView(reader, f.input("evidence", { evidence: target }));
    const observed = (target: typeof evidence) => observe(reader, { name: "evidence", run: (ctx) => serveWorldView(ctx, f.input("evidence", { evidence: target })) });
    const missing = await observed(absent);
    const wrong = await observed(ownerEvidence);
    expect(wrong).toEqual(missing);
    expect(read(evidence).quoted).toHaveLength(1);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "revoke-card-source" });
    expect(await observed(evidence)).toEqual(missing);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_audit").get()!.n).toBeGreaterThan(0);
  } finally { f.dispose(); }
});

test("purge erases evidence targets and narrowed grants cannot redeem retained references", async () => {
  const f = await cardFixture();
  try {
    const agent = addAgent(f.db, "purge-reader", { ...OWNER_AGENT_GRANT });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const evidence = f.card(reader).definitions[0]!.assessments[0]!.evidence[0]!;
    const input = f.input("evidence", { evidence });
    setGrant(f.db, "purge-reader", { subjects: [] });
    expect(serveWorldView(reader, input).data).toEqual({ status: "not_found" });
    const ownerEvidence = f.card().definitions[0]!.assessments[0]!.evidence[0]!;
    purgeEvents(f.db, f.ctx.vaultPath, { event_id: f.definition.event.event_id }, "purge-definition");
    expect(serveWorldView(f.ctx, f.input("evidence", { evidence: ownerEvidence }))).toMatchObject({ canon: [], quoted: [], data: { status: "not_found" } });
  } finally { f.dispose(); }
});

test("forged spans, mismatched admissions, version tampering and malformed refs fail closed", async () => {
  const f = await cardFixture();
  try {
    const evidence = f.card().definitions[0]!.assessments[0]!.evidence[0]!;
    await f.write("concept.example", { kind: "literal", value: "Another source span" });
    const other = f.card().relations[0]!.assessments[0]!.evidence[0]!;
    for (const target of [{ ...evidence, admission: other.admission }, { ...evidence, span: { kind: "text", startUtf16: 1, endUtf16: 3 } }]) {
      expect(serveWorldView(f.ctx, f.input("evidence", { evidence: target })).data).toEqual({ status: "not_found" });
    }
    for (const target of [{ ...evidence, extra: true }, { ...evidence, eventVersion: { kind: "object", token: evidence.eventVersion.token } }, { ...evidence, span: { kind: "text", startUtf16: 0, endUtf16: Number.MAX_SAFE_INTEGER + 1 } }]) {
      expect(() => serveWorldView(f.ctx, f.input("evidence", { evidence: target }))).toThrow("invalid arguments: world_view");
    }
    f.db.query("UPDATE events SET text='Changed bytes' WHERE event_id=?").run(f.definition.event.event_id);
    expect(serveWorldView(f.ctx, f.input("evidence", { evidence })).data).toEqual({ status: "not_found" });
  } finally { f.dispose(); }
});

test("UTF-16 anchors map to code-point expansion; credentials are redacted and a cut through one is refused", async () => {
  const f = await cardFixture();
  try {
    const agent = addAgent(f.db, "span-reader", { ...OWNER_AGENT_GRANT });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const text = "A 😀 prefix. The selected span. suffix";
    const start = text.indexOf("The"), end = text.indexOf(" suffix");
    await f.write("concept.example", { kind: "literal", value: "Unicode span" }, { text, span: { start, end } });
    const evidence = f.card(reader).relations[0]!.assessments[0]!.evidence[0]!;
    expect(serveWorldView(reader, f.input("evidence", { evidence })).quoted[0]!.text).toBe(text.slice(start, end));
    await f.write("concept.counterexample", { kind: "literal", value: "Redacted capture" }, { text: "A record with secret=syntheticCredentialValue and a suffix." });
    const secret = f.card(reader).relations.find((r) => r.predicate === "concept.counterexample")!.assessments[0]!.evidence[0]!;
    const quote = serveWorldView(reader, f.input("evidence", { evidence: secret })).quoted[0]!;
    expect(quote.text).not.toContain("syntheticCredentialValue");
    expect(quote.text).toContain("[redacted:");
    const partial = "secret=anotherSyntheticValue";
    await f.write("concept.example", { kind: "literal", value: "Unsafe secret cut" }, { text: partial, span: { start: 9, end: 15 } });
    const cut = f.card(reader).relations.find((r) => r.object.kind === "literal" && r.object.value === "Unsafe secret cut")!.assessments[0]!.evidence[0]!;
    expect(serveWorldView(reader, f.input("evidence", { evidence: cut })).data).toEqual({ status: "not_found" });
  } finally { f.dispose(); }
});

test("evidence is noninterfering in bytes, refusals and work counters through the shared driver", async () => {
  const leaks = await checkNoninterference({
    cases: (scene) => {
      const result = serveWorldView(scene.reader, {
        operation: "concept", concept: scene.refs.concept, valid: { kind: "all" }, knownAt: { kind: "current" },
      });
      const card = "result" in result.data && result.data.result.status !== "unavailable" ? result.data.result.data : null;
      if (card?.schema !== "kizuki.concept-card/v1") throw new Error("concept card unavailable");
      const evidence = card.definitions[0]!.assessments[0]!.evidence[0]!;
      return [{ name: "evidence", run: (ctx) => serveWorldView(ctx, { operation: "evidence", evidence, valid: { kind: "all" }, knownAt: { kind: "current" } }) }];
    },
  });
  expect(leaks).toEqual([]);
}, 120_000);

test("evidence expansion states its code-point bound and audits invalid and ungranted calls", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.example", { kind: "literal", value: "A long captured span" }, { text: "😀".repeat(2100) });
    const evidence = f.card().relations[0]!.assessments[0]!.evidence[0]!;
    const input = f.input("evidence", { evidence });
    const chunk = serveWorldView(f.ctx, input).quoted[0]!;
    expect(chunk).toMatchObject({ returned: 2000, total: 2100, truncated: true });
    expect(chunk.text).toBe("😀".repeat(2000));
    expect(chunk.slice_integrity).toBe(sha256Hex(chunk.text));
    const count = () => f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_audit").get()!.n;
    const before = count();
    expect(() => serveWorldView(f.ctx, { ...input, evidence: {} })).toThrow("invalid arguments: world_view");
    expect(count()).toBe(before + 1);
    const agent = addAgent(f.db, "ungranted-reader", { ...OWNER_AGENT_GRANT, tools: [] });
    const denied = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const beforeDenial = count();
    expect(() => serveWorldView(denied, input)).toThrow("tool not granted");
    expect(count()).toBe(beforeDenial + 1);
  } finally { f.dispose(); }
});
