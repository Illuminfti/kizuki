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

test("effect flags stay pinned and a wake does not confer a capability", () => {
  const requestDigest = `sha256:${"ef".repeat(32)}`;
  const handle = `cap:clock:sha256:${"ab".repeat(32)}`;
  const base = {
    requestDigest,
    output: { noted: true },
    executor: "synthetic",
    cached: true,
    retryable: false,
  };
  const parsed = parseAlgalRunReceipt(receipt({ effects: [base] }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported effect flags pinned");
  expect(parsed.event.text).toContain("executor-reported wake absent");
  expect(parsed.event.text).toContain("capability not conferred");
  expect(parsed.event.text).not.toContain(handle);
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_effect_flags: "pinned",
      wake: "absent",
      capability: "not_conferred",
      grant: "not_conferred",
      independent_observation: "absent",
    },
  });
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...base, cached: false }] }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...base, retryable: true }] }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...base, wake: [handle] }] }), consent).code)
    .toBe("invalid_record");
  const suspended = {
    requestDigest,
    error: { code: "EFFECT_SUSPENDED", message: "waiting" },
    executor: "synthetic",
    wake: [handle],
  };
  const woken = parseAlgalRunReceipt(receipt({ effects: [suspended] }), consent);
  expect(woken.status).toBe("partial");
  if (woken.status === "refused") return;
  expect(woken.event.text).toContain("executor-reported wake present");
  expect(woken.event.text).toContain("capability not conferred");
  expect(woken.event.text).not.toContain(handle);
  expect(woken.event.text).not.toContain("cap:");
  expect(woken.event.metadata["algal"]).toMatchObject({
    coverage: { wake: "executor_reported", wake_digest: "format_checked_not_resolved", capability: "not_conferred", grant: "not_conferred" },
  });
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...suspended, wake: [handle, handle] }] }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...suspended, wake: ["../outside"] }] }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...suspended, wake: [] }] }), consent).code)
    .toBe("invalid_record");
  const many = Array.from({ length: 17 }, (_, index) => {
    const prefix = index.toString(16).padStart(2, "0");
    return `cap:clock:sha256:${prefix}${"cd".repeat(31)}`;
  });
  expect(parseAlgalRunReceipt(receipt({ effects: [{ ...suspended, wake: many }] }), consent).code)
    .toBe("invalid_record");
});

test("a cell slot stays executor-reported and does not confer access", () => {
  const cell = { status: "committed", work: 0, slot: { name: "fixture-slot", mode: "read" } };
  const parsed = parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": cell } }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported slot present");
  expect(parsed.event.text).toContain("access not conferred");
  expect(parsed.event.text).not.toContain("fixture-slot");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_slot: "present",
      slot_access: "not_conferred",
      grant: "not_conferred",
      independent_observation: "absent",
    },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("access_granted");
  const written = parseAlgalRunReceipt(
    receipt({ cells: { "synthetic/step": { ...cell, slot: { name: "fixture-slot", mode: "write" } } } }),
    consent,
  );
  expect(written.status).toBe("partial");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, slot: { name: "fixture-slot", mode: "execute" } } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, slot: { name: "fixture-slot", mode: "read", grant: true } } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, slot: "read" } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, slot: { mode: "read" } } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, slot: { name: "", mode: "read" } } } }), consent).code)
    .toBe("invalid_record");
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported slot absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: { executor_reported_slot: "absent", slot_access: "not_conferred", grant: "not_conferred" },
  });
});

test("a cell via stays executor-reported and does not confer a route", () => {
  const cell = { status: "committed", work: 0, via: "fixture-via" };
  const parsed = parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": cell } }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported via present");
  expect(parsed.event.text).toContain("route not conferred");
  expect(parsed.event.text).not.toContain("fixture-via");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_via: "present",
      via_route: "not_conferred",
      executed: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("route_granted");
  const pathShaped = parseAlgalRunReceipt(
    receipt({ cells: { "synthetic/step": { ...cell, via: "../outside" } } }),
    consent,
  );
  expect(pathShaped.status).toBe("partial");
  if (pathShaped.status === "refused") return;
  expect(pathShaped.event.text).not.toContain("../outside");
  expect(pathShaped.event.metadata["algal"]).toMatchObject({
    coverage: { executed: false, via_route: "not_conferred", retrieved: false },
  });
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, via: "" } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, via: "x".repeat(129) } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, via: 1 } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, via: { path: "local" } } } }), consent).code)
    .toBe("invalid_record");
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported via absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: { executor_reported_via: "absent", via_route: "not_conferred", grant: "not_conferred" },
  });
});

test("cell rounds and items stay executor-reported and do not confer measured reuse", () => {
  const cell = { status: "committed", work: 0, rounds: 2, items: 0 };
  const parsed = parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": cell } }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported rounds present");
  expect(parsed.event.text).toContain("executor-reported items present");
  expect(parsed.event.text).toContain("measured reuse not conferred");
  expect(parsed.event.text).not.toContain("rounds 2");
  expect(parsed.event.text).not.toContain("items 0");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_rounds: "present",
      executor_reported_items: "present",
      measured_reuse: "not_conferred",
      executed: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("reuse_conferred");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, rounds: -1 } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, rounds: 1.5 } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, rounds: "2" } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, items: { count: 1 } } } }), consent).code)
    .toBe("invalid_record");
  expect(parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": { ...cell, items: Number.MAX_SAFE_INTEGER + 1 } } }), consent).code)
    .toBe("invalid_record");
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported rounds absent");
  expect(absent.event.text).toContain("executor-reported items absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_rounds: "absent",
      executor_reported_items: "absent",
      measured_reuse: "not_conferred",
      grant: "not_conferred",
    },
  });
});

test("cell outputs stay executor-reported and do not confer execution", () => {
  const cell = {
    status: "committed",
    work: 0,
    outputs: { note: "SYNTHETIC_OUTPUT_DO_NOT_COPY", path: "../outside" },
  };
  const parsed = parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": cell } }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported outputs present");
  expect(parsed.event.text).toContain("execution not conferred");
  expect(parsed.event.text).not.toContain("SYNTHETIC_OUTPUT_DO_NOT_COPY");
  expect(parsed.event.text).not.toContain("../outside");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_outputs: "present",
      outputs_execution: "not_conferred",
      executed: false,
      retrieved: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
    receipt: { cells: { "synthetic/step": { outputs: { note: "SYNTHETIC_OUTPUT_DO_NOT_COPY" } } } },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("execution_conferred");
  for (const outputs of [[], "note", 1, null, false]) {
    expect(parseAlgalRunReceipt(
      receipt({ cells: { "synthetic/step": { ...cell, outputs } } }),
      consent,
    ).code).toBe("invalid_record");
  }
  const empty = parseAlgalRunReceipt(
    receipt({ cells: { "synthetic/step": { status: "committed", work: 0, outputs: {} } } }),
    consent,
  );
  expect(empty.status).toBe("partial");
  if (empty.status === "refused") return;
  expect(empty.event.text).toContain("executor-reported outputs present");
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported outputs absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_outputs: "absent",
      outputs_execution: "not_conferred",
      executed: false,
      grant: "not_conferred",
    },
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
