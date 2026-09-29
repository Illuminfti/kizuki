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

test("cell toolCalls stay an executor-reported array and do not confer execution", () => {
  const call = "SYNTHETIC_CALL_DO_NOT_COPY";
  const digest = `sha256:${"cd".repeat(32)}`;
  const cell = {
    status: "committed",
    work: 0,
    toolCalls: [call, "../outside", digest],
    shadowOut: "SYNTHETIC_SHADOW_DO_NOT_PIN",
  };
  const parsed = parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": cell } }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.missingDigests).toEqual([manifestDigest]);
  expect(parsed.event.text).toContain("executor-reported toolCalls present");
  expect(parsed.event.text).toContain("execution not conferred");
  expect(parsed.event.text).not.toContain(call);
  expect(parsed.event.text).not.toContain("../outside");
  expect(parsed.event.text).not.toContain(digest);
  expect(parsed.event.text).not.toContain("SYNTHETIC_SHADOW_DO_NOT_PIN");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_tool_calls: "present",
      tool_calls_execution: "not_conferred",
      executed: false,
      retrieved: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
    receipt: {
      cells: {
        "synthetic/step": {
          toolCalls: [call, "../outside", digest],
          shadowOut: "SYNTHETIC_SHADOW_DO_NOT_PIN",
        },
      },
    },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("execution_conferred");
  for (const toolCalls of [{ name: call }, call, 1, null, false]) {
    expect(parseAlgalRunReceipt(
      receipt({ cells: { "synthetic/step": { status: "committed", work: 0, toolCalls } } }),
      consent,
    ).code).toBe("invalid_record");
  }
  const empty = parseAlgalRunReceipt(
    receipt({ cells: { "synthetic/step": { status: "committed", work: 0, toolCalls: [] } } }),
    consent,
  );
  expect(empty.status).toBe("partial");
  if (empty.status === "refused") return;
  expect(empty.event.text).toContain("executor-reported toolCalls present");
  expect(empty.missingDigests).toEqual([manifestDigest]);
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported toolCalls absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_tool_calls: "absent",
      tool_calls_execution: "not_conferred",
      executed: false,
      grant: "not_conferred",
    },
  });
});

test("event path stays pinned text and is not resolved", () => {
  const outside = "../outside";
  const digest = `sha256:${"ef".repeat(32)}`;
  const parsed = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 0, kind: "run.start", path: outside }] }),
    consent,
  );
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.missingDigests).toEqual([manifestDigest]);
  expect(parsed.event.text).toContain("executor-reported event path present");
  expect(parsed.event.text).toContain("path not resolved");
  expect(parsed.event.text).not.toContain(outside);
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_event_path: "present",
      event_path_resolution: "not_resolved",
      retrieved: false,
      executed: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
    receipt: { events: [{ seq: 0, kind: "run.start", path: outside }] },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("path_resolved");
  for (const path of [{ name: outside }, [outside], 1, null, false, "x".repeat(4097)]) {
    expect(parseAlgalRunReceipt(
      receipt({ events: [{ seq: 0, kind: "run.start", path }] }),
      consent,
    ).code).toBe("invalid_record");
  }
  const bound = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 0, kind: "run.start", path: "x".repeat(4096) }] }),
    consent,
  );
  expect(bound.status).toBe("partial");
  if (bound.status === "refused") return;
  expect(bound.event.text).not.toContain("x".repeat(32));
  const empty = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 0, kind: "run.start", path: "" }] }),
    consent,
  );
  expect(empty.status).toBe("partial");
  if (empty.status === "refused") return;
  expect(empty.event.text).toContain("executor-reported event path present");
  const addressed = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 1, kind: "cell.commit", path: digest }] }),
    consent,
  );
  expect(addressed.status).toBe("partial");
  if (addressed.status === "refused") return;
  expect(addressed.missingDigests).toEqual([manifestDigest]);
  expect(addressed.event.text).not.toContain(digest);
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported event path absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_event_path: "absent",
      event_path_resolution: "not_resolved",
      retrieved: false,
      grant: "not_conferred",
    },
  });
});

test("event outcome stays pinned text and is not an independent observation", () => {
  const reported = "SYNTHETIC_EVENT_OUTCOME";
  const parsed = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 0, kind: "run.end", outcome: reported }] }),
    consent,
  );
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.event.text).toContain("executor-reported event outcome present");
  expect(parsed.event.text).toContain("executor-reported outcome complete");
  expect(parsed.event.text).toContain("independent observation absent");
  expect(parsed.event.text).not.toContain(reported);
  expect(parsed.event.text).not.toContain("independently observed");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_event_outcome: "present",
      event_outcome_observation: "not_independent",
      executor_reported_outcome: "complete",
      independent_observation: "absent",
      executed: false,
      grant: "not_conferred",
    },
    receipt: { events: [{ seq: 0, kind: "run.end", outcome: reported }] },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("observed_success");
  for (const outcome of [{ name: reported }, [reported], 1, null, false, "z".repeat(33)]) {
    expect(parseAlgalRunReceipt(
      receipt({ events: [{ seq: 0, kind: "run.end", outcome }] }),
      consent,
    ).code).toBe("invalid_record");
  }
  const bound = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 0, kind: "run.end", outcome: "y".repeat(32) }] }),
    consent,
  );
  expect(bound.status).toBe("partial");
  if (bound.status === "refused") return;
  expect(bound.event.text).not.toContain("y".repeat(32));
  const empty = parseAlgalRunReceipt(
    receipt({ events: [{ seq: 0, kind: "run.end", outcome: "" }] }),
    consent,
  );
  expect(empty.status).toBe("partial");
  if (empty.status === "refused") return;
  expect(empty.event.text).toContain("executor-reported event outcome present");
  expect(empty.event.metadata["algal"]).toMatchObject({
    coverage: { executor_reported_outcome: "complete" },
  });
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported event outcome absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_event_outcome: "absent",
      event_outcome_observation: "not_independent",
      independent_observation: "absent",
      grant: "not_conferred",
    },
  });
});

test("effect error message stays pinned text and is not copied", () => {
  const requestDigest = `sha256:${"cd".repeat(32)}`;
  const reported = "SYNTHETIC_EFFECT_ERROR_MESSAGE";
  const effect = {
    requestDigest,
    executor: "synthetic",
    error: { code: "INTERNAL", message: reported },
  };
  const parsed = parseAlgalRunReceipt(receipt({ effects: [effect] }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.missingDigests).toEqual([manifestDigest, requestDigest]);
  expect(parsed.event.text).toContain("executor-reported effect error message present");
  expect(parsed.event.text).toContain("message not copied");
  expect(parsed.event.text).not.toContain(reported);
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_effect_error_message: "present",
      effect_error_message: "not_copied",
      executed: false,
      grant: "not_conferred",
    },
    receipt: { effects: [effect] },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("error_observed");
  for (const message of [{ text: reported }, [reported], 1, null, false, "e".repeat(2049)]) {
    expect(parseAlgalRunReceipt(
      receipt({ effects: [{ ...effect, error: { code: "INTERNAL", message } }] }),
      consent,
    ).code).toBe("invalid_record");
  }
  const bound = parseAlgalRunReceipt(
    receipt({ effects: [{ ...effect, error: { code: "INTERNAL", message: "e".repeat(2048) } }] }),
    consent,
  );
  expect(bound.status).toBe("partial");
  if (bound.status === "refused") return;
  expect(bound.event.text).not.toContain("e".repeat(32));
  const units = "\u{1F44D}".repeat(1024);
  expect(units.length).toBe(2048);
  const utf16 = parseAlgalRunReceipt(
    receipt({ effects: [{ ...effect, error: { code: "INTERNAL", message: units } }] }),
    consent,
  );
  expect(utf16.status).toBe("partial");
  expect(parseAlgalRunReceipt(
    receipt({ effects: [{ ...effect, error: { code: "INTERNAL", message: `${units}x` } }] }),
    consent,
  ).code).toBe("invalid_record");
  const empty = parseAlgalRunReceipt(
    receipt({ effects: [{ ...effect, error: { code: "INTERNAL", message: "" } }] }),
    consent,
  );
  expect(empty.status).toBe("partial");
  if (empty.status === "refused") return;
  expect(empty.event.text).toContain("executor-reported effect error message present");
  expect(empty.event.text).not.toContain(reported);
  const root = parseAlgalRunReceipt(
    receipt({ failure: { code: "INTERNAL", message: "r".repeat(2049), path: "synthetic/root" } }),
    consent,
  );
  expect(root.status).toBe("partial");
  const cell = parseAlgalRunReceipt(
    receipt({ cells: { "synthetic/step": { status: "failed", work: 0, failure: { code: "INTERNAL", message: "c".repeat(2049) } } } }),
    consent,
  );
  expect(cell.status).toBe("partial");
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported effect error message absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_effect_error_message: "absent",
      effect_error_message: "not_copied",
      grant: "not_conferred",
    },
  });
});

test("cell shadowOut stays in the receipt and does not confer a decision", () => {
  const reported = "SYNTHETIC_SHADOW_DO_NOT_COPY";
  const outside = "../outside";
  const digest = `sha256:${"ef".repeat(32)}`;
  const cell = {
    status: "committed",
    work: 0,
    outputs: { out: "taken-label" },
    shadowOut: reported,
  };
  const parsed = parseAlgalRunReceipt(receipt({ cells: { "synthetic/step": cell } }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.missingDigests).toEqual([manifestDigest]);
  expect(parsed.event.text).toContain("executor-reported shadowOut present");
  expect(parsed.event.text).toContain("decision not conferred");
  expect(parsed.event.text).toContain("executor-reported outcome complete");
  expect(parsed.event.text).not.toContain(reported);
  expect(parsed.event.text).not.toContain("taken-label");
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_shadow_out: "present",
      shadow_out: "not_copied",
      shadow_decision: "not_conferred",
      executor_reported_outcome: "complete",
      executed: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
    receipt: { cells: { "synthetic/step": cell } },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("decision_conferred");
  const unbound = [
    { take: outside, bound: reported },
    [outside, reported],
    0,
    1.5,
    null,
    false,
    true,
    "",
    digest,
  ];
  for (const shadowOut of unbound) {
    const admitted = parseAlgalRunReceipt(
      receipt({ cells: { "synthetic/step": { status: "committed", work: 0, shadowOut } } }),
      consent,
    );
    expect(admitted.status).toBe("partial");
    if (admitted.status === "refused") return;
    expect(admitted.missingDigests).toEqual([manifestDigest]);
    expect(admitted.event.text).toContain("executor-reported shadowOut present");
    expect(admitted.event.text).not.toContain(outside);
    expect(admitted.event.text).not.toContain(reported);
    expect(admitted.event.text).not.toContain(digest);
    expect(admitted.event.metadata["algal"]).toMatchObject({
      coverage: { shadow_decision: "not_conferred", shadow_out: "not_copied" },
      receipt: { cells: { "synthetic/step": { shadowOut } } },
    });
  }
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported shadowOut absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_shadow_out: "absent",
      shadow_out: "not_copied",
      shadow_decision: "not_conferred",
      grant: "not_conferred",
    },
  });
});

test("effect output stays in the receipt and does not confer execution", () => {
  const requestDigest = `sha256:${"cd".repeat(32)}`;
  const reported = "SYNTHETIC_EFFECT_OUTPUT_DO_NOT_COPY";
  const outside = "../outside";
  const digest = `sha256:${"ef".repeat(32)}`;
  const effect = {
    requestDigest,
    executor: "synthetic",
    output: reported,
  };
  const parsed = parseAlgalRunReceipt(receipt({ effects: [effect] }), consent);
  expect(parsed.status).toBe("partial");
  if (parsed.status === "refused") return;
  expect(parsed.missingDigests).toEqual([manifestDigest, requestDigest]);
  expect(parsed.missingDigests).not.toContain(digest);
  expect(parsed.event.text).toContain("executor-reported effect output present");
  expect(parsed.event.text).toContain("execution not conferred");
  expect(parsed.event.text).toContain("executor-reported outcome complete");
  expect(parsed.event.text).not.toContain(reported);
  expect(parsed.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_effect_output: "present",
      effect_output: "not_copied",
      effect_output_execution: "not_conferred",
      executor_reported_outcome: "complete",
      executed: false,
      retrieved: false,
      grant: "not_conferred",
      independent_observation: "absent",
    },
    receipt: { effects: [effect] },
  });
  expect(JSON.stringify(parsed.event.metadata)).not.toContain("execution_conferred");
  const unbound = [
    { take: outside, bound: reported },
    [outside, reported],
    0,
    1.5,
    null,
    false,
    true,
    "",
    digest,
  ];
  for (const output of unbound) {
    const admitted = parseAlgalRunReceipt(
      receipt({ effects: [{ requestDigest, executor: "synthetic", output }] }),
      consent,
    );
    expect(admitted.status).toBe("partial");
    if (admitted.status === "refused") return;
    expect(admitted.missingDigests).toEqual([manifestDigest, requestDigest]);
    expect(admitted.event.text).toContain("executor-reported effect output present");
    expect(admitted.event.text).not.toContain(outside);
    expect(admitted.event.text).not.toContain(reported);
    expect(admitted.event.text).not.toContain(digest);
    expect(admitted.event.metadata["algal"]).toMatchObject({
      coverage: { effect_output_execution: "not_conferred", effect_output: "not_copied", retrieved: false },
      receipt: { effects: [{ output }] },
    });
  }
  const erred = parseAlgalRunReceipt(
    receipt({
      effects: [{
        requestDigest,
        executor: "synthetic",
        error: { code: "INTERNAL", message: reported },
      }],
    }),
    consent,
  );
  expect(erred.status).toBe("partial");
  if (erred.status === "refused") return;
  expect(erred.event.text).toContain("executor-reported effect output absent");
  expect(erred.event.text).not.toContain(reported);
  const absent = parseAlgalRunReceipt(receipt(), consent);
  expect(absent.status).toBe("partial");
  if (absent.status === "refused") return;
  expect(absent.event.text).toContain("executor-reported effect output absent");
  expect(absent.event.metadata["algal"]).toMatchObject({
    coverage: {
      executor_reported_effect_output: "absent",
      effect_output: "not_copied",
      effect_output_execution: "not_conferred",
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
