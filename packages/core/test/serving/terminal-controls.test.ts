import { expect, test } from "bun:test";
import { serveContextPacket } from "../../src/serving/packet";
import { serveFixture, storeEvent } from "./helpers";

test("packet text removes terminal sequences and separator controls for every principal", async () => {
  const f = await serveFixture();
  try {
    const controls = "\x1b]0;title\x07\x1b[2J\x1b]52;c;QUJD\x07\x9b2J\x9d52;c;QUJD\x9c\x1c\x1d\x1e";
    storeEvent(f.db, "control-note", "2026-02-28T10:34:00Z", `kettle ${controls} done`, "person:ada", "public");
    for (const ctx of [f.owner(), f.agent("reader-public")]) {
      const packet = (await serveContextPacket(ctx, { purpose: "recall", budget_tokens: 2000, include: ["timeline"],
        since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z" })).data!.packet_md;
      expect(packet).toContain("kettle");
      expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(packet)).toBe(false);
      expect(packet).not.toContain("QUJD");
    }
  } finally { f.dispose(); }
});
