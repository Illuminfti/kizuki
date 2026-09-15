/** Design-only traces that source loss cannot resurrect queued work. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-source-loss-design.json");

type Trace = {
  id: string;
  job_state: "queued" | "in_flight";
  control: "revoke" | "purge" | "none";
  prepared_policy_revision: number;
  current_policy_revision: number;
  source_permitted: boolean;
  purge_complete: boolean;
  maintenance_pending: boolean;
  admits_with_prepared_snapshot: boolean;
  serves_disallowed: boolean;
  new_effects_from_lost_support: number;
  executable_pending_payload: boolean;
  payload_contains_erased_evidence: boolean;
  replay_new_effect: boolean;
  delayed_claim: boolean;
  delayed_canon: boolean;
  delayed_retrieval: boolean;
  unaffected_source: boolean;
  blocked_because_other_source_lost: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  traces: Trace[];
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function traceErrors(trace: Trace): string[] {
  const errors: string[] = [];
  if (trace.control === "revoke" || trace.control === "purge") {
    if (trace.admits_with_prepared_snapshot) errors.push(`${trace.id}: admitted with the queued policy snapshot`);
    if (trace.serves_disallowed) errors.push(`${trace.id}: served newly disallowed support`);
    if (trace.replay_new_effect) errors.push(`${trace.id}: replay after control produced a new effect`);
    if (trace.new_effects_from_lost_support !== 0) errors.push(`${trace.id}: new effects from lost support`);
  }
  if (trace.control === "revoke") {
    if (trace.purge_complete && trace.maintenance_pending) {
      errors.push(`${trace.id}: revocation pending presented as completed physical erasure`);
    }
    if (trace.purge_complete) errors.push(`${trace.id}: revoke manufactured a completed purge`);
  }
  if (trace.control === "purge" && trace.purge_complete) {
    if (trace.maintenance_pending) errors.push(`${trace.id}: purge complete still pending maintenance`);
    if (trace.executable_pending_payload && trace.payload_contains_erased_evidence) {
      errors.push(`${trace.id}: purge-complete retained an executable erased payload`);
    }
    if (trace.delayed_claim || trace.delayed_canon || trace.delayed_retrieval) {
      errors.push(`${trace.id}: delayed result recreated claim, canon, or retrieval`);
    }
  }
  if (trace.unaffected_source && trace.blocked_because_other_source_lost) {
    errors.push(`${trace.id}: blocked solely because another source lost permission`);
  }
  return errors;
}

function sourceLossErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "queued-inflight-source-loss-does-not-resurrect") errors.push("unexpected example id");
  const ids = example.traces.map((trace) => trace.id);
  if (ids.join() !== "queued_revoke,inflight_revoke,queued_purge,inflight_purge,unaffected_source") {
    errors.push("required traces drifted");
  }
  for (const trace of example.traces) errors.push(...traceErrors(trace));
  return errors;
}

test("queued and in-flight source loss leaves zero new effects from lost support", () => {
  expect(sourceLossErrors(load())).toEqual([]);
});

test("snapshot admission, delayed resurrection, or blocking an unaffected source fail", () => {
  const example = load();
  expect(sourceLossErrors(example)).toEqual([]);
  const queuedRevoke = example.traces.find((trace) => trace.id === "queued_revoke")!;
  const inflightPurge = example.traces.find((trace) => trace.id === "inflight_purge")!;
  const unaffected = example.traces.find((trace) => trace.id === "unaffected_source")!;
  expect(
    sourceLossErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === queuedRevoke.id
          ? { ...trace, admits_with_prepared_snapshot: true, purge_complete: true, maintenance_pending: true }
          : trace,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    sourceLossErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === inflightPurge.id
          ? {
              ...trace,
              delayed_claim: true,
              delayed_canon: true,
              delayed_retrieval: true,
              replay_new_effect: true,
              executable_pending_payload: true,
              payload_contains_erased_evidence: true,
            }
          : trace,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    sourceLossErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === unaffected.id ? { ...trace, blocked_because_other_source_lost: true } : trace,
      ),
    }).length,
  ).toBeGreaterThan(0);
});
