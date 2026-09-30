import { expect, test } from "bun:test";
import { serveWorldView, readWorldView } from "@kizuki/core/world";
import { cardFixture } from "./card-fixture";

test("evidence text travels only in the untrusted quoted channel with an integrity pin", async () => {
  const f = await cardFixture();
  try {
    const evidence = f.card().definitions[0]!.assessments[0]!.evidence[0]!;
    const input = f.input("evidence", { evidence });
    const envelope = serveWorldView(f.ctx, input);
    expect(envelope.quoted).toHaveLength(1);
    expect(envelope.quoted[0]).toMatchObject({ text: f.definition.event.text, tainted: true, evidence });
    expect(envelope.quoted[0]).toHaveProperty("integrity");
    expect(JSON.stringify(envelope.data)).not.toContain(f.definition.event.text);
    expect(envelope.canon).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain(f.definition.event.event_id);
    expect(readWorldView(f.ctx, input)).toEqual(envelope.data);
  } finally { f.dispose(); }
});
