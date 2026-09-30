import { expect, test } from "bun:test";
import { parseCase } from "./parsers";
import type { Parser } from "./parsers";

test.each(["screenpipe-frame", "screenpipe-audio"])("%s reaches the evidence projection", target => {
  const text = "synthetic captured evidence";
  expect(parseCase(target as Parser, { id: "synthetic", text, bytes: Buffer.from(text) }, true))
    .toMatchObject({ text, sensitivity_hint: "private" });
});

test("WHOOP corpus reaches each resource and retains private sensitivity", () => {
  const text = "{}";
  const result = parseCase("whoop" as Parser, { id: "synthetic", text, bytes: Buffer.from(text) }, true);
  expect(result).toBeArray();
  expect(result).toHaveLength(4);
  for (const event of result as unknown[]) expect(event).toMatchObject({ kind: "health", sensitivity_hint: "private" });
});
