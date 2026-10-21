import { expect, test } from "bun:test";
import { insertClaim } from "../../src/claims/store";
import { FIXTURE_EMBEDDING_SPACE } from "../../src/claims/dedup";
import { claimsDb, claimInput, FixtureVectorPort, putEvent } from "./helpers";
for (const space of ["local-http:synthetic-model@768", null, FIXTURE_EMBEDDING_SPACE]) {
  test(`unqualified or degraded semantic space preserves structural claim insertion (${space})`, async () => {
    const db = claimsDb(), retrieval = new FixtureVectorPort();
    try {
      const first = await insertClaim({ db, retrieval }, claimInput(putEvent(db)));
      expect(first.outcome).toBe("stored");
      const search = retrieval.search.bind(retrieval);
      retrieval.search = async query => ({ ...await search(query), space, degraded: space === FIXTURE_EMBEDDING_SPACE ? ["vector-backlog"] : [] });
      const next = await insertClaim({ db, retrieval }, claimInput(putEvent(db), { body: "Grace works on partnerships at Acme." }));
      expect(next.dedup).toBe("structural-only");
      expect(next.outcome).toBe("duplicate");
      expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n).toBe(1);
    } finally { db.close(); }
  });
}
