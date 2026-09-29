import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept } from "../src/ledger/ledger";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import {
  EXTERNAL_RETENTION_CLASSES, bindSourceModelPort, inspectSourceGrant, retentionAccepted, setSourceGrant, sourceEventsAllowed,
} from "../src/ledger/source-grants";
import { validEvent } from "./fixtures";
import { initVault } from "../src/vault/init";
import { ulid } from "../src/util/ulid";
import { sha256Hex } from "../src/util/hash";

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const endpoint = "https://models.example.test/v1/chat/completions";
const policy = (external_retention: string) => ({
  purposes: ["capture", "recall", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked",
  egress: { model_endpoint: endpoint, model: "fixture-model", external_retention },
  sensitivity_floor: "private",
});

describe("retention classes in source consent", () => {
  test("the ladder is ordered and an undeclared destination is the loosest promise", () => {
    expect([...EXTERNAL_RETENTION_CLASSES]).toEqual(["zero_retention", "logged_no_training", "logged_and_trained", "provider_managed"]);
    expect(retentionAccepted("zero_retention", "zero_retention")).toBe(true);
    expect(retentionAccepted("zero_retention", "logged_no_training")).toBe(false);
    expect(retentionAccepted("logged_no_training", "zero_retention")).toBe(true);
    expect(retentionAccepted("logged_no_training", "logged_and_trained")).toBe(false);
    expect(retentionAccepted("zero_retention", undefined)).toBe(false);
    expect(retentionAccepted("logged_no_training", undefined)).toBe(false);
    // Existing grants named provider_managed and bound undeclared models: they keep working.
    expect(retentionAccepted("provider_managed", undefined)).toBe(true);
    expect(retentionAccepted("provider_managed", "logged_and_trained")).toBe(true);
  });

  test("a grant accepts each class, refuses an unknown one, and a legacy grant keeps its digest", () => {
    const vault = mkdtempSync(join(tmpdir(), "retention-classes-")); dirs.push(vault); initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const source = ulid(); registerConnection(db, "kizuki.fixture", source);
    expect(() => setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "bad", policy: policy("forever") as never })).toThrow("unsupported_retention");
    let revision = 0;
    for (const cls of EXTERNAL_RETENTION_CLASSES) {
      const result = setSourceGrant(db, { source_key: source, expected_revision: revision, operation_id: `grant-${cls}`, policy: policy(cls) as never });
      revision = result.revision;
      const grant = inspectSourceGrant(db, source)!;
      expect(grant.policy.egress).toEqual({ model_endpoint: endpoint, model: "fixture-model", external_retention: cls });
      // The stored digest is over the exact policy JSON, so the legacy value hashes as it always did.
      expect(grant.policy_digest).toBe(sha256Hex(JSON.stringify(grant.policy)));
    }
  });

  test("consent binds the destination's declared class: a narrower grant refuses a looser or undeclared model", () => {
    const vault = mkdtempSync(join(tmpdir(), "retention-classes-")); dirs.push(vault); initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const source = ulid(); registerConnection(db, "kizuki.fixture", source);
    let revision = 0;
    const grantWith = (cls: string, op: string) => { revision = setSourceGrant(db, { source_key: source, expected_revision: revision, operation_id: op, policy: policy(cls) as never }).revision; };
    grantWith("provider_managed", "g0");
    const stored = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "one", text: "Synthetic evidence." }, { source: { source_key: source, expected_revision: 1 } });
    if (stored.status !== "stored") throw new Error("fixture capture failed");
    const event = stored.event.event_id;
    const scope = (retention?: "zero_retention" | "logged_no_training" | "logged_and_trained") => {
      const port = bindSourceModelPort({}, { model_endpoint: endpoint, model: "fixture-model", ...(retention === undefined ? {} : { retention }) });
      return { owner: false, purpose: "extract" as const, model: true, port };
    };
    expect(sourceEventsAllowed(db, [event], scope())).toBe(true);
    expect(sourceEventsAllowed(db, [event], scope("logged_and_trained"))).toBe(true);
    grantWith("zero_retention", "g1");
    expect(sourceEventsAllowed(db, [event], scope("zero_retention"))).toBe(true);
    expect(sourceEventsAllowed(db, [event], scope("logged_no_training"))).toBe(false);
    expect(sourceEventsAllowed(db, [event], scope())).toBe(false);
    grantWith("logged_no_training", "g2");
    expect(sourceEventsAllowed(db, [event], scope("zero_retention"))).toBe(true);
    expect(sourceEventsAllowed(db, [event], scope("logged_no_training"))).toBe(true);
    expect(sourceEventsAllowed(db, [event], scope("logged_and_trained"))).toBe(false);
    expect(() => bindSourceModelPort({}, { model_endpoint: endpoint, model: "fixture-model", retention: "provider_managed" as never })).toThrow("unsupported_retention");
  });
});
