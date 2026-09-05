/** Static design-oracle checks. This does not execute a proposed product API. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Row;
}
function text(value: unknown): string { assert.equal(typeof value, "string"); return value as string; }
function number(value: unknown): number { assert(typeof value === "number" && Number.isSafeInteger(value)); return value; }
function array(value: unknown): unknown[] { assert(Array.isArray(value)); return value; }
function strings(value: unknown): string[] { return array(value).map(text); }
function rows(value: unknown): Row[] { return array(value).map(row); }
function at(value: unknown): number {
  const source = text(value);
  assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(source), "fixture clock must use whole-second UTC");
  const result = Date.parse(source);
  assert(Number.isFinite(result));
  assert.equal(new Date(result).toISOString(), source.replace("Z", ".000Z"));
  return result;
}
function index(value: unknown): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const item of rows(value)) {
    const id = text(item.id); assert(!result.has(id), `duplicate ${id}`); result.set(id, item);
  }
  return result;
}
function get(map: Map<string, Row>, key: unknown): Row {
  const id = text(key), value = map.get(id); assert(value, `missing ${id}`); return value;
}
function sameSet(actual: Iterable<string>, expected: Iterable<string>): void {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function load(name: string, cap: number): { fixture: Row; bytes: Uint8Array; sha256: string } {
  const bytes = readFileSync(new URL(name, import.meta.url));
  assert(bytes.length <= cap, `${name} exceeds its design-file bound`);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const fixture = row(JSON.parse(source));
  assert.equal(fixture.evaluation_state, "not_run");
  return { fixture, bytes, sha256: digest(bytes) };
}
function symbols(fixture: Row): { all: Map<string, Row>; refs: string[] } {
  const all = new Map<string, Row>(), refs: string[] = [];
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value === null || typeof value !== "object") return;
    const object = row(value);
    if (Object.hasOwn(object, "id")) {
      const id = text(object.id); assert(!all.has(id), `duplicate symbol ${id}`); all.set(id, object);
    }
    for (const [key, child] of Object.entries(object)) {
      if (key.endsWith("_ref") && typeof child === "string") refs.push(child);
      if (key.endsWith("_refs") && Array.isArray(child)) refs.push(...strings(child));
      walk(child);
    }
  }
  walk(fixture);
  return { all, refs };
}

const base = load("world-concept-design.json", 96 * 1024);
const extension = load("world-longitudinal-design.json", 32 * 1024);
const bs = symbols(base.fixture), xs = symbols(extension.fixture);
for (const ref of bs.refs) assert(bs.all.has(ref), `unresolved base ref ${ref}`);
for (const ref of xs.refs) assert(ref.startsWith("base:") ? bs.all.has(ref.slice(5)) : xs.all.has(ref), `unresolved extension ref ${ref}`);
assert.equal(row(extension.fixture.base).file, "world-concept-design.json");
assert.equal(row(extension.fixture.base).sha256, base.sha256);
assert.equal(extension.fixture.status, "future_unimplemented");

const bi = row(base.fixture.input), bo = row(base.fixture.oracle);
const br = index(bi.records), bc = index(bi.controls), bq = index(bi.queries);
for (const record of br.values()) assert(at(record.available_at) <= at(record.core_accepted_at));
for (const admission of rows(bi.controlled_admission_schedule)) {
  const record = get(br, admission.record_ref);
  assert(at(record.core_accepted_at) < at(admission.admitted_at));
  assert(number(record.core_admission_seq) < number(admission.core_admission_seq));
}
for (const control of bc.values()) {
  for (const key of ["evidence_refs", "selected_record_refs"]) {
    for (const id of strings(control[key] ?? [])) assert(at(get(br, id).core_accepted_at) <= at(control.available_at));
  }
  for (const id of strings(control.depends_on_refs ?? [])) assert(at(get(bc, id).available_at) < at(control.available_at));
  if (control.prepared_job_ref) assert(at(get(bc, control.prepared_job_ref).available_at) < at(control.available_at));
}
function baselineTiming(query: Row, queries: Map<string, Row>, baseline: unknown): void {
  assert(at(query.known_at) <= at(query.delivery_at));
  if (baseline === undefined) return;
  const old = get(queries, baseline), delta = at(query.delivery_at) - at(old.delivery_at);
  assert(delta > 0 && delta < 900_000); assert.equal(query.principal_ref, old.principal_ref);
}
for (const assertion of rows(bo.assertions)) {
  const query = get(bq, assertion.query_ref); baselineTiming(query, bq, assertion.compare_query_ref);
  for (const id of strings(assertion.evidence_refs)) assert(at(get(br, id).core_accepted_at) <= at(query.known_at));
  for (const id of strings(assertion.semantic_control_refs)) assert(at(get(bc, id).available_at) <= at(query.known_at));
  for (const id of strings(assertion.delivery_control_refs)) assert(at(get(bc, id).available_at) <= at(query.delivery_at));
}
for (const support of rows(bo.support_expectations)) {
  const record = get(br, support.record_ref), span = row(support.span_utf16);
  assert.equal(span.start, 0); assert.equal(span.end, text(record.content).length);
  assert(at(support.raw_available_at) <= at(support.admitted_at));
  for (const id of strings(support.prerequisite_support_refs ?? [])) assert(at(get(bs.all, id).admitted_at) <= at(support.admitted_at));
}
const early = get(bq, "q_before_interpretation");
assert(at(get(br, "r01").core_accepted_at) < at(early.known_at));
assert(rows(bo.support_expectations).every(item => at(item.admitted_at) > at(early.known_at)));
const released: [string, Map<string, Row>][] = [["released_record_refs", br], ["released_control_refs", bc], ["query_refs", bq]];
assert.equal(rows(bi.steps).length, 4);
for (const [field, entries] of released) {
  const seen: string[] = [];
  for (const step of rows(bi.steps)) for (const id of strings(step[field])) {
    const record = get(entries, id); assert(at(record.available_at ?? record.delivery_at) <= at(step.release_until)); seen.push(id);
  }
  assert.equal(new Set(seen).size, seen.length); sameSet(seen, entries.keys());
}
const remaining = new Set(br.keys());
for (const id of ["ctl_purge_s1", "ctl_purge_copy"]) {
  const control = get(bc, id), selected = strings(control.selected_record_refs);
  assert.equal(selected.length, 1); assert.equal(control.expected_selected_raw_event_count, 1);
  for (const selectedId of selected) assert(remaining.delete(selectedId));
  sameSet(remaining, strings(control.retained_raw_record_refs));
}
sameSet(remaining, ["r02", "r03", "r04", "r06"]);
assert.equal(get(br, "r01").content, get(br, "r05").content);
assert.deepEqual(get(br, "r03").record_occurrence, { kind: "unknown" });
for (const source of rows(bi.sources)) assert(["public", "personal", "private"].includes(text(source.default_sensitivity)));
const principals = index(bi.principals);
assert.equal(get(principals, "g1").role, "synthetic_owner_controlled_client");
sameSet(strings(get(principals, "g1").permitted_subject_refs), ["scope_s1", "scope_s2", "scope_s3", "scope_s4"]);
sameSet(strings(get(principals, "g2").permitted_subject_refs), ["scope_s1", "scope_s2", "scope_s3"]);
for (const record of br.values()) assert.deepEqual(record.raw_subject_refs, [`scope_${text(record.source_ref)}`]);
assert.deepEqual(get(bc, "ctl_narrow_g1").removed_subject_refs, ["scope_s4"]);
assert.equal(row(base.fixture.harness_contract).view_token_ttl_seconds, 900);

const xi = row(extension.fixture.input), xo = row(extension.fixture.oracle);
const xr = index(xi.records), xc = index(xi.controls), xq = index(xi.queries), xa = index(xi.artifacts);
assert.equal(xr.size, 7); assert.equal(xa.size, 2);
const ordering: [number, number][] = [];
for (const record of xr.values()) {
  assert.equal(record.source_ref, "base:s2");
  assert(at(record.available_at) > at(row(extension.fixture.base).start_after));
  assert(at(record.available_at) <= at(record.core_accepted_at));
  assert(at(record.core_accepted_at) < at(record.controlled_admitted_at));
  assert(number(record.capture_seq) < number(record.admission_seq));
  ordering.push([at(record.core_accepted_at), number(record.capture_seq)], [at(record.controlled_admitted_at), number(record.admission_seq)]);
  for (const id of strings(record.artifact_refs ?? [])) assert(at(get(xa, id).available_at) <= at(record.core_accepted_at));
}
for (const control of xc.values()) {
  ordering.push([at(control.available_at), number(control.admission_seq)]);
  for (const id of strings(control.target_record_refs ?? [])) assert(at(get(xr, id).controlled_admitted_at) < at(control.available_at));
}
assert.deepEqual(ordering.sort((a,b) => a[0]-b[0]).map(item => item[1]), Array.from({length: ordering.length}, (_,i) => i+22));
for (const query of xq.values()) baselineTiming(query, xq, query.baseline_query_ref);
for (const assertion of rows(xo.assertions)) for (const id of strings(assertion.query_refs)) {
  const query = get(xq, id);
  for (const ref of strings(assertion.evidence_refs)) {
    const record = ref.startsWith("base:") ? get(br, ref.slice(5)) : get(xr, ref);
    assert(at(record.controlled_admitted_at ?? record.core_accepted_at) <= at(query.known_at));
  }
  for (const ref of strings(assertion.artifact_refs ?? [])) assert(at(get(xa, ref).available_at) <= at(query.known_at));
  for (const ref of strings(assertion.semantic_control_refs)) assert(at(get(xc, ref).available_at) <= at(query.known_at));
  for (const ref of strings(assertion.delivery_control_refs ?? [])) assert(at(get(xc, ref).available_at) <= at(query.delivery_at));
}
const outcomes = ["x_r_agent_done", "x_r_provider_ack", "x_r_wrong_version", "x_r_correct_version"];
for (const [i,id] of ["x_q_agent", "x_q_ack", "x_q_wrong", "x_q_correct"].entries()) {
  assert.deepEqual(outcomes.filter(key => at(get(xr, key).controlled_admitted_at) <= at(get(xq,id).known_at)), outcomes.slice(0,i+1));
}
const required = "Copies are not independent evidence.";
assert(!text(get(xa,"x_artifact_v1").content).includes(required));
assert(text(get(xa,"x_artifact_v2").content).includes(required));
assert(text(get(xa,"x_artifact_v2").content).includes("Retries repeat safely"));
const correction = get(xc,"x_ctl_correct_c1");
assert(at(get(xr,"x_r_correct_version").controlled_admitted_at) < at(correction.correction_deadline));
assert(!strings(correction.target_record_refs).includes("x_r_c2"));
const entities=index(xo.entities), c1=get(entities,"x_c1"), c2=get(entities,"x_c2");
assert.equal(c1.goal_ref,c2.goal_ref); assert.notEqual(c1.actor_ref,c2.actor_ref);
assert(strings(c1.evidence_refs).every(id => !strings(c2.evidence_refs).includes(id)));
const snapshot=row(xi.snapshot);
sameSet(strings(snapshot.retained_base_record_refs), [...remaining].map(id => `base:${id}`));
sameSet(strings(snapshot.excluded_raw_record_refs), ["base:r01","base:r05"]);
sameSet(strings(snapshot.retained_extension_record_refs), xr.keys());
sameSet(strings(snapshot.artifact_refs), xa.keys());
assert.equal(snapshot.live_view_tokens_included,false);
assert.equal(snapshot.available_at,get(xc,"x_ctl_export").available_at);
for (const record of xr.values()) assert(at(record.controlled_admitted_at) < at(snapshot.available_at));
assert(at(snapshot.available_at) < at(get(xc,"x_ctl_restore").available_at));
const old=get(xq,"x_q_restored_old_token"), issued=get(xq,old.baseline_query_ref);
assert.equal(at(old.delivery_at)-at(issued.delivery_at),240_000);
assert(at(issued.delivery_at) < at(get(xc,"x_ctl_restore").available_at));
assert(at(get(xc,"x_ctl_restore").available_at) < at(old.delivery_at));

console.log(JSON.stringify({
  validation:"static_pass", product_execution:false,
  concept:{sha256:base.sha256,bytes:base.bytes.length,symbols:bs.all.size,references:bs.refs.length,records:br.size,controls:bc.size,queries:bq.size},
  extension:{sha256:extension.sha256,bytes:extension.bytes.length,symbols:xs.all.size,references:xs.refs.length,records:xr.size,controls:xc.size,queries:xq.size},
  checked:["reference closure","chronological oracle isolation","exact purge selections","subject-scope mapping","distinct commitments","four outcome prefixes","restore within token TTL"],
  limitation:"Design data only; no extraction, policy runtime, migration, restore, client parity or quality claim."
},null,2));
