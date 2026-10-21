import { expect, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent } from "../../src/agents";
import { claimKey } from "../../src/claims/hash";
import { insertClaim, listClaims } from "../../src/claims/store";
import { stampRuleClasses } from "../../src/ledger/event-classes";
import { bindSourceEvent, setSourceGrant } from "../../src/ledger/source-grants";
import { claimReader } from "../../src/serving/claims";
import { serveContextPacket } from "../../src/serving/packet";
import { ulid } from "../../src/util/ulid";
import { claimInput } from "../claims/helpers";
import { serveFixture, storeEvent, type Fixture } from "./helpers";

async function claim(f: Fixture, event: string, object: string): Promise<string> {
  const result = await insertClaim({ db: f.db }, claimInput(event, {
    subject: "person:ada", subjects: ["person:ada"],
    predicate: "employment.role", object,
    body: `Ada has role ${object}.`, sensitivity: "public",
  }));
  if (result.outcome !== "stored" && result.outcome !== "contested")
    throw new Error(`fixture claim: ${result.outcome}`);
  return result.outcome === "stored" ? result.claim.claim_id : result.incoming.claim_id;
}

test("class-denied histories cannot erase a readable conflict by exhausting its group bound", async () => {
  const f = await serveFixture();
  try {
    const first = await claim(f, f.events.public!, "Engineer");
    const second = await claim(f, f.events.public!, "Manager");
    const read = (name: string) => serveContextPacket(f.agent(name), {
      purpose: "recall", include: ["claims"], budget_tokens: 2000,
    });
    const before = (await read("reader-public")).data!;
    expect(before.packet_md).toContain("- conflict key=");
    const event = storeEvent(f.db, "classed-history", "2026-02-28T10:00:00Z",
      "Synthetic classified history.", "person:ada", "public");
    stampRuleClasses(f.db, event, [{ path_glob: "classed-history", class: "credential" }]);
    const template = await claim(f, event, "Classified role");
    const fields = f.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('claims')")
      .all().map(row => row.name);
    const copy = f.db.prepare(`INSERT INTO claims (${fields.join(",")})
      SELECT ${fields.map(field => field === "claim_id" ? "?" : field).join(",")}
      FROM claims WHERE claim_id=?`);
    try {
      // Two readable claims plus 10,000 class-denied rows exceed the history
      // bound only for a reader explicitly authorized to see those rows.
      f.db.transaction(() => {
        for (let n = 1; n < 10_000; n++) copy.run(ulid(), template);
      })();
    } finally { copy.finalize(); }
    const after = (await read("reader-public")).data!;
    expect(after.packet_md).toContain("- conflict key=");
    expect(after.packet_md).toContain(first);
    expect(after.packet_md).toContain(second);
    expect(after.packet_md).not.toContain(template);
    expect(after.sections).toEqual(before.sections);
    expect(after.truncated).toBe(before.truncated);
    f.tokens["class-open"] = addAgent(f.db, "class-open", {
      ...OWNER_AGENT_GRANT, ceiling: "public", deny_classes: [],
    }).token;
    expect((await read("class-open")).data!.packet_md).not.toContain("- conflict key=");
  } finally { f.dispose(); }
});

test("compiled claim visibility preserves the reader's effective source purpose", async () => {
  const f = await serveFixture();
  try {
    setSourceGrant(f.db, {
      source_key: f.sourceKey, expected_revision: 0, operation_id: "session-only",
      policy: {
        purposes: ["capture", "derive", "session"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
      },
    });
    bindSourceEvent(f.db, f.events.public!, { source_key: f.sourceKey, expected_revision: 1 });
    const id = await claim(f, f.events.public!, "Session reader");
    const ctx = f.agent("reader-public");
    for (const purpose of ["session", "recall"] as const) {
      const reader = claimReader(f.db, ctx.principal.grant, { owner: false, purpose });
      const selected = listClaims(f.db, { status: "live",
        claim_key: claimKey("person:ada", "employment.role"), visibility: reader.visibility });
      expect(selected.map(row => row.claim_id)).toEqual(purpose === "session" ? [id] : []);
      const packet = (await serveContextPacket(ctx, {
        purpose, include: ["claims"], budget_tokens: 1200,
      })).data!;
      expect(packet.packet_md.includes(id)).toBe(purpose === "session");
    }
  } finally { f.dispose(); }
});
