/** Docs must describe --port persist on successful full rebuild, not the superseded bound-only contract. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const LIMITS = join(ROOT, "packages/core/RETRIEVAL-REBUILD.md");
const CLI = join(ROOT, "docs/cli.md");

function rebuildSection(markdown: string): string {
  const at = markdown.search(/^## rebuild\s*$/m);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(at);
  const next = rest.slice(1).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function staleBoundOnlyClaims(text: string): string[] {
  const errors: string[] = [];
  if (/must name the currently bound store/i.test(text)) {
    errors.push("still claims --port must name the currently bound store");
  }
  if (/does not switch engines/i.test(text)) {
    errors.push("still claims --port does not switch engines");
  }
  if (/refuses any other id/i.test(text)) {
    errors.push("still claims --port refuses any other id");
  }
  return errors;
}

function persistContractErrors(text: string): string[] {
  const errors: string[] = [];
  if (!/--port/.test(text)) errors.push("missing --port");
  if (!/serve\.toml/.test(text)) errors.push("missing serve.toml persist boundary");
  if (!/port_state/.test(text)) errors.push("missing port_state");
  if (!/flips/.test(text)) errors.push("missing success persist");
  if (!/does not rewrite/i.test(text) && !/not rewritten/i.test(text)) {
    errors.push("missing non-persist contract for failed or partial rebuild");
  }
  return errors;
}

test("rebuild docs no longer describe the bound-only --port contract", () => {
  const limits = readFileSync(LIMITS, "utf8");
  const cli = rebuildSection(readFileSync(CLI, "utf8"));
  expect(staleBoundOnlyClaims(limits)).toEqual([]);
  expect(staleBoundOnlyClaims(cli)).toEqual([]);
  expect(persistContractErrors(limits)).toEqual([]);
  expect(persistContractErrors(cli)).toEqual([]);
});

test("restoring the bound-only --port claim fails the docs contract", () => {
  const stale = "`--port ID` must name the currently bound store and does not switch engines.";
  expect(staleBoundOnlyClaims(stale).length).toBeGreaterThan(0);
  expect(persistContractErrors(stale).length).toBeGreaterThan(0);
});
