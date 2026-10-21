import { expect } from "bun:test";
import { world } from "./golden-app";
import type { StdioClient } from "./two-clients";
import { envelopeOf } from "../client";

/** Assert exact local connector metadata through the public consumer, never insert an artifact fixture. */
export async function exactArtifact(client: StdioClient, text: string) {
  const sha256 = new Bun.CryptoHasher("sha256").update(Buffer.from(text)).digest("hex");
  const matches = (await world(client, { operation: "find_artifacts", label: sha256.slice(0, 12) })).result.data.matches;
  expect(matches).toHaveLength(1);
  const ref = matches[0].ref;
  const result = (await world(client, { operation: "artifact_version", artifact: ref })).result;
  expect(result.status).toBe("current");
  expect(result.data.content).toEqual({ sha256, mediaType: "text/markdown", byteLength: Buffer.byteLength(text) });
  expect(result.data.original).toEqual({ status: "unavailable" });
  expect(result.data.inspections).toEqual([]);
  expect(result.data.versionOf).not.toBeNull();
  const evidence = result.data.versionOf.assessments[0].evidence[0];
  const expanded = await client.call("world_view", { operation: "evidence", evidence, response_contract: "kizuki.envelope/v2" });
  expect(expanded.isError ?? false).toBe(false);
  expect((envelopeOf(expanded).quoted as { text: string }[]).some(quote => quote.text === text)).toBe(true);
  return { ref, content: result.data.content, versionOf: result.data.versionOf.object };
}
