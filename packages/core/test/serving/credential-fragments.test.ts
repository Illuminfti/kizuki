import { expect, test } from "bun:test";
import { serveTimeline } from "../../src/serving/timeline";
import { serveFixture, storeEvent } from "./helpers";

test("a wrapped variable-length token with a short or long final fragment is redacted whole", async () => {
  const f = await serveFixture();
  try {
    for (const length of [1, 12, 600]) {
      const text = `sk-${"A".repeat(24)}\n${"B".repeat(length)}\nnext line: keep this`;
      const id = storeEvent(f.db, `wrapped-tail-${length}`, "2026-02-28T10:30:00Z", text, "person:ada", "public");
      const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
      expect(answer.quoted[0]?.text).toBe("[redacted:api_token]\nnext line: keep this");
      expect(answer.redacted).toEqual({ api_token: 1 });
    }
  } finally { f.dispose(); }
});
