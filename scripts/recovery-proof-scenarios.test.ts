import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { observeRecoveryScenarios } from "./recovery-proof-scenarios";
import { validateScenarioObservation } from "./recovery-proof-receipt";
import { RECOVERY_RECIPE } from "./recovery-proof-recipe";

test("all fixed recovery scenarios preserve their observations through real source CLI and MCP children", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-recovery-source-test-"));
  try {
    const results = await observeRecoveryScenarios(root, [process.execPath, resolve(import.meta.dir, "../packages/cli/src/main.ts")], [process.execPath, resolve(import.meta.dir, "../packages/mcp/src/bin.ts")], (id, error) => console.error(id, error, error instanceof Error ? error.cause : null));
    expect(results.map(result => ({ id: result.id, failure: result.failure, last_command: result.commands.at(-1)?.id, last_check: result.checks.at(-1)?.id })))
      .toEqual(RECOVERY_RECIPE.scenarios.map(recipe => ({ id: recipe.id, failure: null, last_command: recipe.commands.at(-1)!.id, last_check: recipe.checks.at(-1)!.id })));
    for (const [index, result] of results.entries()) {
      const recipe = RECOVERY_RECIPE.scenarios[index]!;
      expect(() => validateScenarioObservation(result, index)).not.toThrow();
      expect(result.commands.map(command => command.id)).toEqual(recipe.commands.map(command => command.id));
      expect(result.checks.map(check => check.id)).toEqual(recipe.checks.map(check => check.id));
      expect(result.fixtures.map(fixture => fixture.id)).toEqual(recipe.fixtures.map(fixture => fixture.id));
      expect(result.tools.map(tool => tool.id)).toEqual(recipe.tools.map(tool => tool.id));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 240000);
