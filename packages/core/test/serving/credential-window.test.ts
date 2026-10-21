import { expect, test } from "bun:test";
import { serveContextPacket, serveContextPacketV2 } from "../../src/serving/packet";
import { storeEvent } from "./helpers";
import { credentialFixture } from "./credential-fixture";
import { packetView } from "../../src/serving/v2/context-packet";

test("a clipped replacement in a packet preview is counted once and kept verbatim", async () => {
  const f = await credentialFixture();
  try {
    storeEvent(f.db, "clipped-secret", "2026-02-28T10:30:00Z",
      `kettle ${"X".repeat(135)} DB_PASSWORD=${"synthetic" + "Credential123"}`, "person:ada", "public");
    const answer = await serveContextPacket(f.agent("reader-public"), {
      purpose: "recall", include: ["timeline"], budget_tokens: 2000,
      since: "2026-02-28T10:29:00Z", until: "2026-02-28T10:31:00Z",
    });
    const quoted = answer.quoted[0];
    if (quoted === undefined || !("event_id" in quoted)) throw new Error("expected a captured event preview");
    const preview = quoted.text;
    expect(Array.from(preview)).toHaveLength(160);
    expect(answer.data!.packet_md).toContain(preview);
    expect(answer.redacted).toEqual({ secret_assignment: 1 });
  } finally { f.dispose(); }
});

test("a v2 packet keeps clipped replacement bytes stable across its retained view", async () => {
  const f = await credentialFixture();
  try {
    storeEvent(f.db, "clipped-v2-secret", "2026-02-28T10:30:00Z",
      `kettle ${"X".repeat(135)} DB_PASSWORD=${"synthetic" + "Credential123"}`, "person:ada", "public");
    const args = { purpose: "recall" as const, include: ["timeline" as const], budget_tokens: 2000,
      since: "2026-02-28T10:29:00Z", until: "2026-02-28T10:31:00Z" };
    const answer = await serveContextPacketV2(f.agent("reader-public"), args);
    if (answer.data.result.status !== "current") throw new Error("expected a complete current packet");
    const preview = answer.quoted[0]!.text;
    expect(Array.from(preview)).toHaveLength(160);
    expect(answer.data.result.data.packetMd).toContain(preview);
    expect(packetView(answer.data.result.data, answer.canon, answer.quoted)).toEqual(answer.data.result.view);
    const again = await serveContextPacketV2(f.agent("reader-public"), { ...args, priorView: answer.data.result.view });
    expect(again.data.result).toMatchObject({ status: "unchanged", view: answer.data.result.view });
  } finally { f.dispose(); }
});
