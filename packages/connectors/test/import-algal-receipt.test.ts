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
