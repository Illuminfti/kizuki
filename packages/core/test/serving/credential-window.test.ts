import { expect, test } from "bun:test";
import { serveContextPacket } from "../../src/serving/packet";
import { serveFixture, storeEvent } from "./helpers";

test("a clipped replacement in a packet preview is counted once and kept verbatim", async () => {
  const f = await serveFixture();
  try {
    storeEvent(f.db, "clipped-secret", "2026-02-28T10:30:00Z",
      `kettle ${"X".repeat(135)} DB_PASSWORD=${"synthetic" + "Credential123"}`, "person:ada", "public");
    const answer = await serveContextPacket(f.agent("reader-public"), {
      purpose: "recall", include: ["timeline"], budget_tokens: 2000,
      since: "2026-02-28T10:29:00Z", until: "2026-02-28T10:31:00Z",
    });
    const preview = answer.quoted[0]!.text;
    expect(Array.from(preview)).toHaveLength(160);
    expect(answer.data!.packet_md).toContain(preview);
    expect(answer.redacted).toEqual({ secret_assignment: 1 });
  } finally { f.dispose(); }
});
