import { expect, test } from "bun:test";
import { fuzzStdioBytes, mcpFuzzDriver } from "./fuzz-driver";
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
