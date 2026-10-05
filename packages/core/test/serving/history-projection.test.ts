import { describe, expect, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { historyTree } from "../../src/serving/history";
import type { QuotedChunk } from "../../src/serving/types";

function quoted(event_id: string, text: string): QuotedChunk {
  return {
    event_id, connector_id: "fixture", kind: "message", occurred_at: `2026-02-28T${event_id}:00:00Z`,
    sensitivity: "public", subjects: [], text, tainted: true,
  };
}

describe("history projection", () => {
  test("uses a byte-bounded chronological sample with oldest and newest detail", () => {
    const data = historyTree(OWNER, [
      quoted("10", `OLDEST-${"a".repeat(100)}`),
      quoted("11", `MIDDLE-${"b".repeat(100)}`),
      quoted("12", `NEWEST-${"c".repeat(100)}`),
    ], 128, undefined, "fixture");
    expect(new TextEncoder().encode(data.node.text).byteLength).toBeLessThanOrEqual(128);
    expect(data.node.text).toContain("OLDEST-");
    expect(data.node.text).toContain("NEWEST-");
    expect(data.node.text.indexOf("OLDEST-")).toBeLessThan(data.node.text.indexOf("NEWEST-"));
  });
});
