import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept } from "../src/ledger/ledger";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import {
  bindSourceJudgePort, bindSourceModelPort, inheritSourcePortBindings, setSourceGrant, sourceEventsAllowed, sourcePortBindingDigest,
} from "../src/ledger/source-grants";
import { validEvent } from "./fixtures";
import { initVault } from "../src/vault/init";
import { ulid } from "../src/util/ulid";
import { sha256Hex } from "../src/util/hash";

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
  const source = ulid(); registerConnection(db, "kizuki.fixture", source);
  let revision = 0;
  const grant = (egress: Record<string, string>) => {
    revision = setSourceGrant(db, { source_key: source, expected_revision: revision, operation_id: `g${revision}`, policy: policy(egress) as never }).revision;
  };
  grant({ ...model, external_retention: "provider_managed" });
  const stored = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "one", text: "Synthetic evidence." }, { source: { source_key: source, expected_revision: 1 } });
  if (stored.status !== "stored") throw new Error("fixture capture failed");
  return { db, grant, event: stored.event.event_id };
}
const scope = (port: object) => ({ owner: false, purpose: "extract" as const, model: true, port });

describe("a configured System One judge is model egress", () => {
  test("events are sent only when the grant consents to the judge's exact endpoint and model", () => {
    const { db, grant, event } = ledgerWithEvent();
    const plain = bindSourceModelPort({}, model);
    expect(sourceEventsAllowed(db, [event], scope(plain))).toBe(true);

    // The grant names the extraction model only: a producer that also feeds a judge elsewhere is held.
    const judged = bindSourceJudgePort(bindSourceModelPort({}, model), judge);
    expect(sourceEventsAllowed(db, [event], scope(judged))).toBe(false);

    // A grant for the judge's destination does not cover the extraction model either.
    grant({ ...judge, external_retention: "provider_managed" });
    expect(sourceEventsAllowed(db, [event], scope(judged))).toBe(false);

    // One destination serving both roles is consented as one.
    const same = bindSourceJudgePort(bindSourceModelPort({}, model), model);
    grant({ ...model, external_retention: "provider_managed" });
    expect(sourceEventsAllowed(db, [event], scope(same))).toBe(true);
    // A different model on the consented endpoint is not consented.
    const otherModel = bindSourceJudgePort(bindSourceModelPort({}, model), { ...model, model: "another-judge" });
    expect(sourceEventsAllowed(db, [event], scope(otherModel))).toBe(false);
  });

  test("the judge's retention class is compared like the model's, and undeclared is the loosest", () => {
    const { db, grant, event } = ledgerWithEvent();
    grant({ ...model, external_retention: "zero_retention" });
    const declared = bindSourceJudgePort(bindSourceModelPort({}, { ...model, retention: "zero_retention" }), { ...model, retention: "zero_retention" });
    expect(sourceEventsAllowed(db, [event], scope(declared))).toBe(true);
    const undeclaredJudge = bindSourceJudgePort(bindSourceModelPort({}, { ...model, retention: "zero_retention" }), model);
    expect(sourceEventsAllowed(db, [event], scope(undeclaredJudge))).toBe(false);
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
