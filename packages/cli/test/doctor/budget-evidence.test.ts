import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";

const h = createHelpers();
afterEach(h.cleanup);

test("doctor JSON reports unavailable budget evidence without leaking or changing a torn receipt", () => {
  const { vault, env } = h.tempVault();
  const path = join(vault, ".kizuki/receipts/promotions.jsonl");
  const bytes = '{"synthetic_private_receipt_body":';
  mkdirSync(join(vault, ".kizuki/receipts"), { recursive: true });
  writeFileSync(path, bytes);
  const result = h.runCli(env, "doctor", "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe("error");
  expect(report.data.serve.model.budget.canon_writes_per_day.used).toBeNull();
  expect(report.data.serve.calibration.canon_writes_today).toBeNull();
  expect(report.data.serve.failures).toContain("canon write budget unavailable: inspect canon receipt recovery");
  expect(result.stdout).not.toContain("synthetic_private_receipt_body");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});
