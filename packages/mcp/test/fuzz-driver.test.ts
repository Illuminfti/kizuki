import { expect, test } from "bun:test";
import { fuzzStdioBytes, mcpFuzzDriver } from "./fuzz-driver";
import { call, connectClient } from "./client";
import { mcpFixture } from "./helpers";

test("malformed stdio frames refuse and leave the ping seam responsive", async () => {
  const fixture = mcpFixture();
  try {
    for (const text of ["null", "[]", "{", '"text"']) {
      await fuzzStdioBytes(fixture.owner(), Buffer.from(text));
    }
  } finally { fixture.dispose(); }
});

test("non-object MCP arguments are protocol refusals rather than campaign failures", async () => {
  const fixture = mcpFixture();
  const driver = await mcpFuzzDriver(fixture.owner());
  try {
    for (const args of [null, [], true, 0, "text"]) {
      const result = await driver.call("system_health", args);
      expect(result).toMatchObject({ isError: true });
    }
  } finally { await driver.close(); fixture.dispose(); }
});

test("a generic MCP serving failure fails the campaign instead of counting as refusal", async () => {
  const fixture = mcpFixture();
  const driver = await mcpFuzzDriver(fixture.owner());
  try {
    fixture.db.close();
    await expect(driver.call("system_health", {})).rejects.toThrow("mcp-crash");
  } finally { await driver.close(); fixture.dispose(); }
});

test("an internal failure inside a successful MCP envelope fails the campaign for the owner and for an agent", async () => {
  const fixture = mcpFixture();
  const open: (() => Promise<void>)[] = [];
  try {
    fixture.db.exec("DROP TABLE events");
    const args = { purpose: "recall", budget_tokens: 1000 };
    for (const [ctx, reported] of [
      // The owner envelope reports the failure as an `error` denial.
      [fixture.owner(), { denied: [{ reason: "error", count: 1 }] }],
      // An agent envelope hides denials, so only the degradation names the failure.
      [fixture.agent("reader-private"), { denied: [], data: { retrieval_degraded: ["context-unavailable"] } }],
    ] as const) {
      const raw = await call(await connectClient(ctx, open), "context_packet", args);
      expect(raw.isError).toBeFalsy();
      expect(raw.structuredContent).toMatchObject(reported);
      const driver = await mcpFuzzDriver(ctx);
      try { await expect(driver.call("context_packet", args)).rejects.toThrow("mcp-crash"); } finally { await driver.close(); }
    }
  } finally { for (const close of open.splice(0)) await close(); fixture.dispose(); }
});
