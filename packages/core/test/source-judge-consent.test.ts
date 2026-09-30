import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept } from "../src/ledger/ledger";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import {
  bindSourceJudgePort, bindSourceModelPort, inheritSourcePortBindings, inspectSourceGrant, setSourceGrant, sourceEventsAllowed, sourcePortBindingDigest,
} from "../src/ledger/source-grants";
import { validEvent } from "./fixtures";
import { initVault } from "../src/vault/init";
import { ulid } from "../src/util/ulid";
import { sha256Hex } from "../src/util/hash";

setDefaultTimeout(30_000);
const dirs: string[] = [];
const databases: ReturnType<typeof openLedger>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const model = { model_endpoint: "https://models.example.test/v1/chat/completions", model: "fixture-model" };
const judge = { model_endpoint: "https://judge.example.test/v1/systemone", model: "fixture-judge" };
const policy = (egress: Record<string, string>) => ({
  purposes: ["capture", "recall", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked",
  egress,
  sensitivity_floor: "private",
});

function ledgerWithEvent() {
  const vault = mkdtempSync(join(tmpdir(), "judge-consent-")); dirs.push(vault); initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  databases.push(db);
  const source = ulid(); registerConnection(db, "kizuki.fixture", source);
  let revision = 0;
  const grant = (egress: Record<string, string>) => {
    revision = setSourceGrant(db, { source_key: source, expected_revision: revision, operation_id: `g${revision}`, policy: policy(egress) as never }).revision;
  };
  grant({ ...model, external_retention: "provider_managed" });
  const stored = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "one", text: "Synthetic evidence." }, { source: { source_key: source, expected_revision: 1 } });
  if (stored.status !== "stored") throw new Error("fixture capture failed");
  return { db, grant, source, event: stored.event.event_id };
}
const scope = (port: object) => ({ owner: false, purpose: "extract" as const, model: true, port });

describe("a configured System One judge is model egress", () => {
  test("events are sent only when the grant consents to the judge's exact endpoint and model", () => {
    const { db, grant, event } = ledgerWithEvent();
    const plain = bindSourceModelPort({}, model);
    expect(sourceEventsAllowed(db, [event], scope(plain))).toBe(true);

    // The serving host shape: the chat endpoint and the judge are different destinations.
    const judged = bindSourceJudgePort(bindSourceModelPort({}, model), judge);
    // A grant that names the extraction model only holds the events: the judge was never consented.
    expect(sourceEventsAllowed(db, [event], scope(judged))).toBe(false);
    // The model alone is still consented, so a producer with no judge is unaffected.
    expect(sourceEventsAllowed(db, [event], scope(plain))).toBe(true);

    // A grant for the judge's destination alone does not cover the extraction model.
    grant({ ...judge, external_retention: "provider_managed" });
    expect(sourceEventsAllowed(db, [event], scope(judged))).toBe(false);

    // A grant that names both destinations passes.
    const both = { ...model, external_retention: "provider_managed", judge_endpoint: judge.model_endpoint, judge_model: judge.model };
    grant(both);
    expect(sourceEventsAllowed(db, [event], scope(judged))).toBe(true);
    // Another judge model, or another judge endpoint, than the one named is not consented.
    expect(sourceEventsAllowed(db, [event], scope(bindSourceJudgePort(bindSourceModelPort({}, model), { ...judge, model: "another-judge" })))).toBe(false);
    expect(sourceEventsAllowed(db, [event], scope(bindSourceJudgePort(bindSourceModelPort({}, model), { ...judge, model_endpoint: "https://elsewhere.example.test/v1/systemone" })))).toBe(false);

    // One destination serving both roles is consented as one.
    const same = bindSourceJudgePort(bindSourceModelPort({}, model), model);
    grant({ ...model, external_retention: "provider_managed" });
    expect(sourceEventsAllowed(db, [event], scope(same))).toBe(true);
    // A different model on the consented endpoint is not consented.
    const otherModel = bindSourceJudgePort(bindSourceModelPort({}, model), { ...model, model: "another-judge" });
    expect(sourceEventsAllowed(db, [event], scope(otherModel))).toBe(false);
  });

  test("a judge pair is both keys or neither, and an absent pair leaves the policy digest as it was", () => {
    const { db, grant, source } = ledgerWithEvent();
    const row = () => db.query("SELECT policy_digest AS d, policy AS p FROM source_grants").get() as { d: string; p: string };
    const digest = () => row().d;
    const legacy = { ...model, external_retention: "provider_managed" as const };
    const before = digest();
    expect(row().p).not.toContain("judge");
    // This is the pre-extension serialization, independent of the current normalizer.
    expect(before).toBe(sha256Hex('{"purposes":["capture","derive","export","extract","recall"],"allowed_fields":["attachments","metadata","subjects","text"],"retention":"persistent_owned_until_revoked","egress":{"model_endpoint":"https://models.example.test/v1/chat/completions","model":"fixture-model","external_retention":"provider_managed"},"sensitivity_floor":"private"}'));
    expect(() => grant({ ...legacy, judge_endpoint: judge.model_endpoint })).toThrow("unsupported_egress");
    expect(() => grant({ ...legacy, judge_model: judge.model })).toThrow("unsupported_egress");
    expect(() => grant({ ...legacy, judge_endpoint: "http://not-loopback.example.test/x", judge_model: judge.model })).toThrow("unsupported_egress");
    expect(() => grant({ ...legacy, judge_endpoint: judge.model_endpoint, judge_model: judge.model, unknown: "field" })).toThrow("unsupported_egress");
    grant({ ...legacy, judge_endpoint: judge.model_endpoint, judge_model: judge.model });
    expect(row().p).toContain("judge_endpoint");
    expect(inspectSourceGrant(db, source)!.policy.egress).toEqual({ ...legacy, judge_endpoint: judge.model_endpoint, judge_model: judge.model });
    expect(digest()).not.toBe(before);
    grant(legacy);
    expect(digest()).toBe(before);
  });

  test("the judge's retention class is compared like the model's, and undeclared is the loosest", () => {
    const { db, grant, event } = ledgerWithEvent();
    grant({ ...model, external_retention: "zero_retention" });
    const declared = bindSourceJudgePort(bindSourceModelPort({}, { ...model, retention: "zero_retention" }), { ...model, retention: "zero_retention" });
    expect(sourceEventsAllowed(db, [event], scope(declared))).toBe(true);
    const undeclaredJudge = bindSourceJudgePort(bindSourceModelPort({}, { ...model, retention: "zero_retention" }), model);
    expect(sourceEventsAllowed(db, [event], scope(undeclaredJudge))).toBe(false);
    // A named judge declares nothing, so a strict grant that names it still holds the events.
    grant({ ...model, external_retention: "zero_retention", judge_endpoint: judge.model_endpoint, judge_model: judge.model });
    const namedJudge = bindSourceJudgePort(bindSourceModelPort({}, { ...model, retention: "zero_retention" }), judge);
    expect(sourceEventsAllowed(db, [event], scope(namedJudge))).toBe(false);
    grant({ ...model, external_retention: "logged_and_trained", judge_endpoint: judge.model_endpoint, judge_model: judge.model });
    expect(sourceEventsAllowed(db, [event], scope(namedJudge))).toBe(true);
  });

  test("a judge is part of the scheduling identity and survives wrapping", () => {
    const base = bindSourceModelPort({}, model);
    const judged = bindSourceJudgePort(bindSourceModelPort({}, model), judge);
    expect(sourcePortBindingDigest(judged)).not.toBe(sourcePortBindingDigest(base));
    expect(sourcePortBindingDigest(inheritSourcePortBindings(judged, {}))).toBe(sourcePortBindingDigest(judged));
    expect(() => bindSourceJudgePort(judged, { ...judge, model: "other" })).toThrow("source_model_binding_conflict");
    // Producers without a judge keep the identity they always had.
    expect(sourcePortBindingDigest(base)).toBe(sha256Hex(`kizuki.source-port/v1\0model\0${model.model_endpoint}\0${model.model}`));
  });
});
