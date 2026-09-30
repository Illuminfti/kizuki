import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { listAudit } from "../../src/agents";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { ServeError } from "../../src/serving/types";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

setDefaultTimeout(60_000);

let fixture: Fixture;
beforeAll(async () => {
  fixture = await serveFixture();
});
afterAll(() => fixture.dispose());

async function refusal(run: () => Promise<unknown>): Promise<ServeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

const DISCOVER = {
  operation: "find_concepts",
  label: "",
  valid: { kind: "all" },
  knownAt: { kind: "current" },
};
const V2 = { response_contract: "kizuki.envelope/v2" };

test("a world_view call the grant does not allow leaves an audit row", async () => {
  const context = fixture.agent("search-only");
  const before = listAudit(fixture.db, "search-only", { kind: "access", limit: 50 }).length;
  expect((await refusal(() => dispatchServeTool(context, "world_view", DISCOVER, V2))).code).toBe("tool_not_granted");
  const rows = listAudit(fixture.db, "search-only", { kind: "access", limit: 50 });
  expect(rows).toHaveLength(before + 1);
  expect(rows[0]?.tool).toBe("world_view");
  expect(rows[0]?.denied).toEqual([{ id: "tool:world_view", reason: "tool_not_granted" }]);
});

test("a world_view call the engine judges invalid leaves an audit row", async () => {
  const context = fixture.agent("reader-private");
  const args = { operation: "concept", valid: { kind: "all" }, knownAt: { kind: "current" } };
  expect((await refusal(() => dispatchServeTool(context, "world_view", args, V2))).code).toBe("invalid_arguments");
  const row = listAudit(fixture.db, "reader-private", { kind: "access", limit: 1 })[0];
  expect(row?.tool).toBe("world_view");
  expect(row?.denied).toEqual([{ id: "tool:world_view", reason: "invalid_arguments" }]);
});

test("denied world_view calls count toward the agent's rate limit", async () => {
  const context = fixture.agent("slow");
  const codes: string[] = [];
  for (let call = 0; call < 3; call += 1) {
    codes.push((await refusal(() => dispatchServeTool(context, "world_view", { operation: "concept" }, V2))).code);
  }
  expect(codes).toEqual(["invalid_arguments", "invalid_arguments", "rate_limited"]);
});
