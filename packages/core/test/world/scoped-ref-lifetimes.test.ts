import { expect, test } from "bun:test";
import { join } from "node:path";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { selectedEventSql } from "../../src/query/selection";
import { referenceScope, type RefScope } from "../../src/world/ref-kinds/common";
import { issueRawSubjectRef, resolveRawSubjectRef } from "../../src/world/ref-kinds/raw-subject";
import { issueCapturedSubjectRef, resolveCapturedSubjectRef, issueEventVersionRef, resolveEventVersionRef } from "../../src/world/ref-kinds/evidence";
import { issueSourceRef, resolveSourceRef } from "../../src/world/ref-kinds/source";
import { issueClaimGroupRef, resolveClaimGroupRef } from "../../src/world/ref-kinds/claim";
import { worldSeed } from "../helpers/world-seed";
import { tempVault } from "../helpers/vault";

async function fixture() {
  const vault = tempVault("kizuki-typed-refs-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const seed = await worldSeed(db, { subject: "topic:same-name", connector: "refs.fixture", discover: false });
  const ctx = { ...seed.ctx, vaultPath: vault.path };
  const run = <T>(read: (scope: RefScope) => T, context = ctx): T => db.transaction(() => read(referenceScope(context))).immediate();
  return { vault, db, seed, ctx, run, dispose() { db.close(); vault.dispose(); } };
}

test("raw subject keeps its token across one purge, but the exact captured subject dies", async () => {
  const f = await fixture();
  try {
    const second = await worldSeed(f.db, { subject: "topic:same-name", connector: "refs.fixture", sourceKey: f.seed.sourceKey, label: "Independent capture", discover: false });
    const semantic = readClaimV2Semantic(f.db, f.seed.claims[0]!)!;
    if (semantic.discriminator !== "assertion") throw new Error("fixture assertion missing");
    const raw = semantic.subject;
    const issued = f.run(scope => ({ raw: issueRawSubjectRef(scope, raw)!, captured: issueCapturedSubjectRef(scope, f.seed.eventId, raw.id)!, event: issueEventVersionRef(scope, f.seed.eventId)! }));
    expect(issued.raw).not.toBeNull();
    expect(f.db.query("SELECT event_id FROM world_wire_raw_subject_members ORDER BY event_id").all()).toHaveLength(2);
    purgeEvents(f.db, f.vault.path, { event_id: f.seed.eventId }, "erase one raw membership");
    f.run(scope => {
      expect(resolveRawSubjectRef(scope, issued.raw)).toEqual(raw);
      expect(issueRawSubjectRef(scope, raw)).toEqual(issued.raw);
      expect(resolveCapturedSubjectRef(scope, issued.captured)).toBeNull();
      expect(resolveEventVersionRef(scope, issued.event)).toBeNull();
    });
    purgeEvents(f.db, f.vault.path, { event_id: second.eventId }, "erase last raw membership");
    f.run(scope => expect(resolveRawSubjectRef(scope, issued.raw)).toBeNull());
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(issued.raw.token)).toBeNull();
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

test("equal raw IDs in different sources stay separate before selection limits", async () => {
  const f = await fixture();
  try {
    const other = await worldSeed(f.db, { subject: "topic:same-name", connector: "refs.fixture", label: "Other namespace", discover: false });
    const raw = { kind: "supplied", id: "topic:same-name", namespace: { connector_id: "refs.fixture", source_key: f.seed.sourceKey } } as const;
    const refs = f.run(scope => [issueRawSubjectRef(scope, raw)!, issueRawSubjectRef(scope, { ...raw, namespace: { ...raw.namespace, source_key: other.sourceKey } })!]);
    expect(refs[0]).not.toEqual(refs[1]);
    const selection = selectedEventSql({ subjects: [raw] });
    expect(f.db.query(`SELECT event_id FROM events WHERE ${selection.sql} ORDER BY event_id LIMIT 1`).all(...selection.bindings)).toEqual([{ event_id: f.seed.eventId }]);
    const agent = addAgent(f.db, "separate-ref-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    f.run(scope => {
      expect(resolveRawSubjectRef(scope, refs[0]!)).toBeNull();
      expect(issueRawSubjectRef(scope, raw)).not.toEqual(refs[0]);
    }, ctx);
  } finally { f.dispose(); }
}, 120_000);

test("source revocation refuses retained memberships and erases the source ref", async () => {
  const f = await fixture();
  try {
    const raw = { kind: "supplied", id: "topic:same-name", namespace: { connector_id: "refs.fixture", source_key: f.seed.sourceKey } } as const;
    const refs = f.run(scope => ({ source: issueSourceRef(scope, f.seed.eventId)!, raw: issueRawSubjectRef(scope, raw)! }));
    expect(refs.source).not.toBeNull();
    revokeSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: 1, operation_id: "revoke-ref-source" });
    f.run(scope => {
      expect(resolveSourceRef(scope, refs.source)).toBeNull();
      expect(resolveRawSubjectRef(scope, refs.raw)).toBeNull();
    });
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(refs.source.token)).toBeNull();
  } finally { f.dispose(); }
}, 120_000);

test("a claim group binds exactly two to sixteen authorized members and dies on member erasure", async () => {
  const f = await fixture();
  try {
    const group = f.run(scope => {
      expect(issueClaimGroupRef(scope, [])).toBeNull();
      expect(issueClaimGroupRef(scope, [f.seed.claims[0]!])).toBeNull();
      expect(issueClaimGroupRef(scope, Array.from({ length: 17 }, (_, i) => `absent-${i}`))).toBeNull();
      const group = issueClaimGroupRef(scope, f.seed.claims)!;
      expect(resolveClaimGroupRef(scope, group)?.map(claim => claim.claim_id)).toEqual([...f.seed.claims].sort());
      expect(resolveClaimGroupRef(scope, { kind: "source", token: group.token })).toBeNull();
      return group;
    });
    purgeEvents(f.db, f.vault.path, { event_id: f.seed.eventId }, "erase claim group basis");
    f.run(scope => expect(resolveClaimGroupRef(scope, group)).toBeNull());
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(group.token)).toBeNull();
  } finally { f.dispose(); }
}, 120_000);
