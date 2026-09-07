import { expect, test } from "bun:test";
import { startServeHttp } from "../../src/serve/http";
import { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";
import { serveFixture } from "../serving/helpers";

test("the daemon HTTP surface uses its host retrieval instance and current authorized content", async () => {
  const f = await serveFixture();
  const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
  const retrieval = new ReferenceRetrievalPort(temporary.ctx);
  let calls = 0;
  retrieval.search = async () => {
    calls += 1;
    return { hits: [{ doc_id: "page:person:ada", kind: "page", score: 1,
      snippet: "STALE_PRIVATE_CACHE_MARKER", sensitivity: "public", taint: "clean", authority: "owner_correction" }],
      degraded: [], timings_ms: {}, space: null };
  };
  const handle = startServeHttp({ db: f.db, vaultPath: f.vaultPath, retrieval });
  try {
    for (const tool of ["search", "context_packet"]) {
      const response = await fetch(`${handle.url}/v1/${tool}`, {
        method: "POST", headers: { authorization: `Bearer ${f.tokens["reader-public"]}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "ketle", ...(tool === "context_packet" ? { budget_tokens: 2000, include: ["canon"] } : {}) }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Ada keeps the kettle warm.");
      expect(text).not.toContain("STALE_PRIVATE_CACHE_MARKER");
    }
    expect(calls).toBe(2);
  } finally {
    await handle.stop();
    await retrieval.close();
    temporary.cleanup();
    f.dispose();
  }
});
