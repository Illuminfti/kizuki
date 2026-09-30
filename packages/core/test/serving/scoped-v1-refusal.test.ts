import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { OWNER_AGENT_GRANT, TOOLS, addAgent, listAudit } from "../../src/agents";
import { hiddenScene } from "../helpers/noninterference";
import { startLoopback } from "../helpers/world-kit/loopback";

setDefaultTimeout(120_000);
const V1 = "kizuki.envelope/v1";
const refusal = { ok: false, error: { code: "unsupported_contract", message: "requested contract unavailable", retryable: false } };

test("every scoped missing or v1 selector is refused and audited before any candidate discovery", async () => {
  const scene = await hiddenScene();
  const http = await startLoopback(scene.db, scene.vaultPath);
  const { token } = addAgent(scene.db, "legacy-selector-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:bayes"] });
  const queries = spyOn(scene.db, "query");
  const prepared = spyOn(scene.db, "prepare");
  try {
    for (const tool of TOOLS) {
      for (const body of [{}, { response_contract: V1, args: {} }]) {
        const reply = await http.post(tool, body, token);
        expect({ tool, ...reply }).toEqual({ tool, status: 400, body: refusal });
      }
    }
    const candidates = [...queries.mock.calls, ...prepared.mock.calls].filter(([sql]) => /\bFROM\s+(?:events|claims|page_index|world_observations)\b/i.test(sql));
    expect(candidates).toEqual([]);
    const rows = listAudit(scene.db, "legacy-selector-reader", { kind: "access", limit: 40 });
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      expect(row.served).toEqual([]);
      expect(row.denied).toEqual([{ id: `tool:${row.tool}`, reason: "unsupported_contract" }]);
    }
    expect((await http.post("search", { query: "Bayesian" })).status).toBe(200);
  } finally {
    queries.mockRestore(); prepared.mockRestore();
    await http.stop(); scene.dispose();
  }
});
