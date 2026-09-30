import { expect, test } from "bun:test";
import { claudeTurn, codexMeta, codexTurn, connectorFor, drain, tempRoot, texts, writeJsonl } from "./helpers";

for (const flavor of ["claude-code", "codex"] as const) {
  test(`${flavor} retains owner words around hook-injected Kizuki context`, async () => {
    const root = await tempRoot();
    const text = "Keep retries deterministic.\n<hook-output>KIZUKI CONTEXT v1\nsynthetic injected context</hook-output>\nPreserve receipts.";
    await writeJsonl(root, "project/turns.jsonl", flavor === "claude-code"
      ? [claudeTurn("u-1", text)] : [codexMeta(), codexTurn("user", text)]);
    const captured = texts((await drain(connectorFor(flavor, { path: root }))).events);
    expect(captured.map((value) => value.replace(/\n+/g, "\n"))).toEqual([
      "Keep retries deterministic.\nPreserve receipts.",
    ]);
  });
}
