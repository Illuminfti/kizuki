import { expect, test } from "bun:test";
import { countLiveClaimsByProducer } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { putEvent, storeClaim } from "../canon/helpers";

test("live claims are counted by producer so page mirrors are not model output", async () => {
  const db = openLedger(":memory:");
  expect(countLiveClaimsByProducer(db)).toEqual({ model: 0, deterministic: 0, owner: 0, agent: 0 });
  const event = putEvent(db);
  const distinct = (n: number) => ({ target: `people/p${n}`, subject: `person:p${n}`, subjects: [`person:p${n}`], body: `Person ${n}.` });
  await storeClaim(db, event, { ...distinct(1), producer: "deterministic" });
  await storeClaim(db, event, { ...distinct(2), producer: "deterministic" });
  await storeClaim(db, event, { ...distinct(3), producer: "model", model_ref: "synthetic/model" });
  await storeClaim(db, event, { ...distinct(4), producer: "agent:example" });
  expect(countLiveClaimsByProducer(db)).toEqual({ model: 1, deterministic: 2, owner: 0, agent: 1 });
  db.close();
});
