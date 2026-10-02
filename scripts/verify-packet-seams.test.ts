import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORLD_OPS } from "../packages/core/src/world/public";
import { WORLD_CLI_OPS } from "../packages/cli/src/commands/world/ops";
import { MCP_WORLD_OPS } from "../packages/mcp/src/world/ops";
import { verifyPacketSeams, verifyWorldSurfaceParity } from "./verify-packet-seams";

const root = resolve(import.meta.dir, "..");
const rows = JSON.parse(readFileSync(resolve(root, "docs/world/packet-seams.json"), "utf8")) as Record<string, unknown>[];

test("F1B registers both packets with real seams and executable acceptance tests", () => {
  expect(rows.filter((row) => row.workstream === "F1B").map((row) => row.packet)).toEqual([482, 484]);
  expect(verifyPacketSeams(root, rows)).toBe(rows.length);
  expect(() => verifyWorldSurfaceParity()).not.toThrow();
});

test("missing seams, missing tests and incomplete surface rows fail the verifier", () => {
  const row = rows[0]!;
  expect(() => verifyPacketSeams(root, [{ ...row, tests: ["packages/core/test/world/absent.test.ts"] }])).toThrow("missing regular file");
  expect(() => verifyPacketSeams(root, [{ ...row, tests: ["packages/core/src/world/public.ts"] }])).toThrow("non-executable");
  expect(() => verifyPacketSeams(root, [{ ...row, seams: { ...(row.seams as object), core: ["packages/core/src/world/absent.ts"] } }])).toThrow("missing regular file");
  for (const surface of ["core", "cli", "mcp", "http", "app"]) {
    expect(() => verifyPacketSeams(root, [{ ...row, [surface]: "" }])).toThrow(`missing ${surface}`);
  }
  expect(() => verifyPacketSeams(root, [row, row])).toThrow("duplicate");
  expect(() => verifyPacketSeams(root, [{ ...row, tests: ["../outside.test.ts"] }])).toThrow("repository-relative");
});

test("a registered operation without CLI or MCP cannot pass parity", () => {
  expect(() => verifyWorldSurfaceParity(WORLD_OPS, WORLD_CLI_OPS.slice(1), MCP_WORLD_OPS)).toThrow("lacks CLI");
  expect(() => verifyWorldSurfaceParity(WORLD_OPS, WORLD_CLI_OPS, MCP_WORLD_OPS.slice(1))).toThrow("lacks MCP");
});

test("ENV registers both packet portions with executable seams and regressions", () => {
  expect(rows.filter((row) => row.workstream === "ENV").map((row) => row.packet)).toEqual([502, 490]);
  expect(verifyPacketSeams(root, rows)).toBe(rows.length);
});
