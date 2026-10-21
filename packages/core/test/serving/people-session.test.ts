import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { insertClaim, markClaimReverted } from "../../src/claims/store";
import { serveContextPacketV2 } from "../../src/serving/packet";
import { personFixture, ADA } from "../helpers/person-fixture";
import { eventFacts, nativeOwnerEvent } from "../claims/helpers";

async function identity(f: Awaited<ReturnType<typeof personFixture>>, source?: string) {
  const body = "person:ada identity.display_name Ada.";
  const native = nativeOwnerEvent(f.db, body);
  const claim = await insertClaim({ db: f.db }, { kind: "claim", subject: ADA, predicate: "identity.display_name", object: "Ada",
    polarity: "positive", body, provenance: [native, ...(source === undefined ? [] : [source])], subjects: [ADA],
    producer: "owner", confidence: 1, events: [eventFacts(native)] });
  if (claim.outcome !== "stored") throw new Error("identity fixture was not stored");
  expect(claim.claim.authority).toBe("owner_authored");
}
async function packet(f: Awaited<ReturnType<typeof personFixture>>, db = f.db) {
  const reply = await serveContextPacketV2({ ...f.ctx, db }, { purpose: "session", budget_tokens: 2000 });
  const result = reply.data?.result;
  if (result === undefined || !("data" in result)) throw new Error("packet content missing");
  return result.data;
}
test.each([false, true])("session Person preference requires a structured source binding (bound=%s)", async bound => {
  const f = await personFixture(undefined, { purposes: ["capture", "derive", "recall", "correction", "export", "session"] });
  try {
    const role = await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA });
    await identity(f, bound ? role.event.event_id : undefined);
    const body = (await packet(f)).packetMd;
    const owner = body.split("## owner")[1]?.split("\n## ")[0] ?? "";
    if (bound) {
      expect(owner).toContain("Person card; quoted data");
      expect(owner).toContain("Reviewer");
      expect(owner).toContain("mode=asserted");
      expect(owner).not.toContain("auth=owner_authored");
    } else {
      expect(owner).toContain("identity.display_name");
      expect(owner).not.toContain("Person card");
    }
  } finally { f.dispose(); }
}, 120_000);

test("the actual packet publication refuses a Person dependency retired after collection", async () => {
  const f = await personFixture(undefined, { purposes: ["capture", "derive", "recall", "correction", "export", "session"] });
  try {
    const role = await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA });
    await identity(f, role.event.event_id);
    if (role.stored.outcome !== "stored") throw new Error("role was not stored");
    const id = role.stored.claim.claim_id;
    let injected = false;
    const db = new Proxy(f.db, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "transaction") return (run: () => unknown) => {
        const tx = target.transaction(run);
        const finish = (result: unknown) => {
          if (!injected && result !== null && typeof result === "object" && "deps" in result) {
            injected = true;
            // The asynchronous packet finishes gathering synchronously, then yields
            // before the gate's final publication transaction.
            queueMicrotask(() => markClaimReverted(f.db, id, new Date().toISOString()));
          }
          return result;
        };
        return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()) });
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Database;
    const result = await packet(f, db).catch(error => error);
    expect(injected).toBe(true);
    expect(result.code).toBe("error");
    expect(String(result)).not.toContain("Reviewer");
  } finally { f.dispose(); }
}, 120_000);
