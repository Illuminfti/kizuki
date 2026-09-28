import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateEventInput } from "@kizuki/core";
import { listConnectorDescriptors } from "../src/registry";
import { sha256Hex } from "../src/source-id";
import {
  ALGAL_RECEIPT_CONNECTOR_ID,
  ALGAL_RECEIPT_CONSENT,
  ALGAL_RUN_RECEIPT_PIN,
  MAX_ALGAL_RECEIPT_BYTES,
  parseAlgalRunReceipt,
} from "../src/import-algal-receipt";

const observed = "2026-09-27T17:30:00.000Z";
const manifestBytes = "{\"organism\":\"synthetic\"}";
const manifestDigest = `sha256:${sha256Hex(manifestBytes)}`;
const receiptDigest = `sha256:${"ab".repeat(32)}`;

function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract: "algal.run.v1",
    runtime: { name: "algal", version: "0.1.0" },
    manifestDigest,
    manifestKey: "/no/such/kizuki-algal-path",
    args: { task: { instruction: "SYNTHETIC_DO_NOT_EXECUTE" } },
    outcome: "complete",
    cells: {},
    effects: [],
    events: [],
    work: { steps: 0, agentCalls: 0, units: 0 },
    digest: receiptDigest,
    ...overrides,
  });
}

const consent = { observedAt: observed, consent: ALGAL_RECEIPT_CONSENT };

test("a consented receipt with supplied manifest bytes becomes one private event", () => {
  const parsed = parseAlgalRunReceipt(receipt(), { ...consent, referencedBytes: { [manifestDigest]: manifestBytes } });
  expect(parsed.status).toBe("normalized");
  if (parsed.status === "refused") return;
  expect(parsed.missingDigests).toEqual([]);
  expect(validateEventInput(parsed.event).ok).toBe(true);
  expect(parsed.event).toMatchObject({
    schema: "kizuki.event/v1",
    connector_id: ALGAL_RECEIPT_CONNECTOR_ID,
    kind: "agent_runtime",
    occurred_at: observed,
    observed_at: observed,
    sensitivity_hint: "private",
    subjects: [],
    deleted: false,
    attachments: [],
  });
  expect(parsed.event.text).not.toContain("SYNTHETIC_DO_NOT_EXECUTE");
  expect(parsed.event.text).toContain("source clock absent");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    pin: ALGAL_RUN_RECEIPT_PIN,
    coverage: { referenced_bytes: "supplied", retrieved: false, executed: false, source_clock: "absent" },
    receipt: { args: { task: { instruction: "SYNTHETIC_DO_NOT_EXECUTE" } }, manifestKey: "/no/such/kizuki-algal-path" },
  });
});

test("an executor-reported complete is not an independent observation", () => {
  const parsed = parseAlgalRunReceipt(receipt(), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported outcome complete");
  expect(parsed.event.text).toContain("independent observation absent");
  expect(parsed.event.text).not.toContain("independently observed");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_outcome: "complete",
      independent_observation: "absent",
      grant: "not_conferred",
    },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("observed_success");
  const failed = parseAlgalRunReceipt(receipt({ outcome: "failed" }), consent);
  expect(failed.status).toBe("partial");
  if (failed.status === "refused") return;
  expect(failed.event.text).toContain("executor-reported outcome failed");
  expect(failed.event.metadata["algal"]).toMatchObject({
    coverage: { executor_reported_outcome: "failed", independent_observation: "absent", grant: "not_conferred" },
  });
});

test("effect usage stays executor-reported and a bad count refuses", () => {
  const requestDigest = `sha256:${"cd".repeat(32)}`;
  const effect = {
    requestDigest,
    output: { approval: "claimed" },
    executor: "synthetic",
    usage: { model: "fixture-model", tokensIn: 3, tokensOut: 1 },
  };
  const parsed = parseAlgalRunReceipt(receipt({ effects: [effect] }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported usage present");
  expect(parsed.event.text).toContain("independent cost observation absent");
  expect(parsed.event.text).not.toContain("fixture-model");
  expect(parsed.event.text).not.toContain("grant conferred");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_usage: "present",
      usage_observation: "not_independent",
      independent_observation: "absent",
      grant: "not_conferred",
    },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("observed_cost");
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...effect, usage: { tokensIn: -1 } }] }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...effect, usage: { approval: true } }] }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ approval: true }), consent).code).toBe("unsupported_field");
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported usage absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: { executor_reported_usage: "absent", grant: "not_conferred" },
  });
});

test("missing manifest bytes stay partial and are not retrieved", () => {
  const parsed = parseAlgalRunReceipt(receipt(), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status !== "partial") return;
  expect(parsed.code).toBe("referenced_bytes_unavailable");
  expect(parsed.missingDigests).toEqual([manifestDigest]);
  expect(parsed.event.text).toContain("bytes not retrieved");
});

test("consent, bad digests, and unknown contracts refuse before any read", () => {
  expect(parseAlgalRunReceipt(receipt(), { observedAt: observed }).code).toBe("consent_required");
  expect(parseAlgalRunReceipt(receipt({ manifestDigest: "https://example.invalid/manifest" }), consent).code).toBe("invalid_digest");
  expect(parseAlgalRunReceipt(receipt({ manifestDigest: "../outside" }), consent).code).toBe("invalid_digest");
  expect(parseAlgalRunReceipt(receipt({ contract: "algal.foundry.v1" }), consent).code).toBe("unsupported_contract");
  expect(parseAlgalRunReceipt(receipt({ fetch: "https://example.invalid/run" }), consent).code).toBe("unsupported_field");
  expect(parseAlgalRunReceipt("[]", consent).code).toBe("not_object");
  expect(parseAlgalRunReceipt("x".repeat(MAX_ALGAL_RECEIPT_BYTES + 1), consent).code).toBe("byte_limit");
});

test("a digest mismatch refuses and the parser is not registered", () => {
  const parsed = parseAlgalRunReceipt(receipt(), { ...consent, referencedBytes: { [manifestDigest]: "other bytes" } });
  expect(parsed).toMatchObject({ status: "refused", code: "digest_mismatch" });
  expect(listConnectorDescriptors().some((port) => port.id === ALGAL_RECEIPT_CONNECTOR_ID)).toBe(false);
  const source = readFileSync(new URL("../src/import-algal-receipt.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/\breadFile|\bfetch\s*\(|node:fs|node:http|child_process/);
});
