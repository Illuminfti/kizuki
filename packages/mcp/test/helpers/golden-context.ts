import { expect } from "bun:test";
import { envelopeOf } from "../client";
import type { StdioClient } from "./two-clients";
import { BLOCKER, LABEL, ORIGINAL, REVISED, RICH, world } from "./golden-app";

const request = { operation: "slice", task: "Resume the Orchard work", budgetTokens: 2000 };
export async function contextStage(owner: StdioClient, peer: StdioClient, rich: boolean) {
  const peerSlice = (await world(peer, { ...request, kinds: ["concept"] })).result;
  expect(peerSlice.status).toBe("current"); expect(peerSlice.view.kind).toBe("view");
  expect(JSON.stringify(peerSlice.data)).toContain(ORIGINAL);
  const artifact = (await world(owner, { ...request, kinds: ["artifact_version"] })).result;
  expect(artifact.data.providers).toEqual([{ kind: "artifact_version", status: "included" }]);
  expect(artifact.data.constraints.some((item: any) => item.relation.predicate === "artifact.version_of" && item.evidence.length > 0)).toBe(true);
  expect(artifact.data.tokens).toBeLessThanOrEqual(2000);
  expect((await world(owner, { ...request, kinds: ["concept"], budgetTokens: 80 })).result).toEqual({ status: "unavailable", reason: "budget" });
  if (rich) {
    const slice = (await world(owner, { ...request, kinds: ["situation"] })).result;
    const constraint = slice.data.constraints.find((item: any) => item.relation.predicate === "situation.blocker");
    expect(constraint).toBeDefined(); expect(constraint.relation.object).toEqual({ kind: "literal", value: BLOCKER });
    expect(constraint.relation.perspective.mode).toBe("reported"); expect(constraint.evidence.length).toBeGreaterThan(0);
    const fullSource = constraint.evidence.find((item: any) => item.span.startUtf16 === 0 && item.span.endUtf16 === RICH.length);
    expect(fullSource).toBeDefined();
    const expanded = await owner.call("world_view", { operation: "evidence", evidence: fullSource, response_contract: "kizuki.envelope/v2" });
    expect(expanded.isError ?? false).toBe(false);
    expect((envelopeOf(expanded).quoted as { text: string }[]).some(quote => quote.text === RICH)).toBe(true);
    const response = await owner.call("context_packet", { purpose: "session", budget_tokens: 2000, response_contract: "kizuki.envelope/v2" });
    expect(response.isError ?? false, JSON.stringify(response)).toBe(false);
    const packet = (envelopeOf(response).data as any).result.data;
    const items = packet.packetMd.split("\n").filter((line: string) => line.includes(" :: slice ")).map((line: string) => JSON.parse(line.split(" :: slice ")[1]!));
    expect(items.find((item: any) => item.relation.predicate === "situation.blocker"), JSON.stringify((envelopeOf(response).data as any).result)).toEqual(constraint);
    expect(packet.packetMd).toContain("## uncertain"); expect(packet.tokens).toBeLessThanOrEqual(2000);
    const small = await owner.call("context_packet", { purpose: "session", budget_tokens: 450, response_contract: "kizuki.envelope/v2" });
    expect(small.isError ?? false).toBe(false);
    const limited = (envelopeOf(small).data as any).result;
    expect(limited.status).toBe("incomplete"); expect(limited.reasons).toContain("required_context_overflow"); expect(limited.data.coverage.gaps).toContain("required_context_overflow");
    expect(limited.data.packetMd).not.toContain(" :: slice "); expect(limited).not.toHaveProperty("view");
  }
  return peerSlice.view;
}

export async function atlasChange(client: StdioClient, ref: unknown, baselineView: unknown, added?: unknown) {
  const result = (await world(client, { operation: "atlas", panel: "changed", focus: { operation: "concept", ref }, baselineView })).result;
  expect(result.data.schema).toBe("kizuki.atlas/v1");
  const panel = result.data.panels[0];
  expect(panel.status).toBe(added === undefined ? "empty" : "ready");
  if (added === undefined) expect(panel.change).toEqual({ added: [], removed: [], changed: [], truncated: false });
  else expect(panel.change.added).toContainEqual(added);
  expect(panel.change.truncated).toBe(false); expect(panel.nextView.kind).toBe("view");
}

export async function contextRefusal(peer: StdioClient, view: unknown, ref: unknown, baselineView: unknown) {
  const slice = (await world(peer, { ...request, kinds: ["concept"], priorView: view })).result;
  expect(slice).toEqual({ status: "new_view_required" });
  const atlas = (await world(peer, { operation: "atlas", panel: "changed", focus: { operation: "concept", ref }, baselineView })).result;
  expect(atlas.data.panels[0]).toMatchObject({ status: "unavailable", reason: "baseline_unusable", change: null, nextView: null });
  for (const text of [ORIGINAL, REVISED, LABEL]) expect(JSON.stringify(atlas)).not.toContain(text);
}

export async function contextErased(owner: StdioClient) {
  const slice = await world(owner, { ...request, kinds: ["concept", "situation", "artifact_version"] });
  const atlas = await world(owner, { operation: "atlas", panel: "home" });
  const session = await owner.call("context_packet", { purpose: "session", budget_tokens: 2000, response_contract: "kizuki.envelope/v2" });
  expect(session.isError ?? false).toBe(false);
  for (const response of [slice, atlas, session])
    for (const text of [ORIGINAL, REVISED, LABEL, BLOCKER]) expect(JSON.stringify(response)).not.toContain(text);
}
