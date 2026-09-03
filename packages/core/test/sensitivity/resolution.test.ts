import { describe, expect, test } from "bun:test";
import {
  OWNER_AGENT_GRANT,
  DEFAULT_GRANT,
  SensitivityError,
  addAgent,
  applyConnectionSensitivity,
  getClaim,
  getConnectorSensitivity,
  insertClaim,
  labelClaimSensitivity,
  policyForSourceClass,
  raiseConnectorSensitivityFloor,
  resolveSensitivity,
  seedConnectorSensitivity,
} from "../../src";
import { agentsDb } from "../agents/helpers";
import { claimInput, claimsDb, eventFacts, putEvent } from "../claims/helpers";

describe("resolveSensitivity", () => {
  test("the connector floor wins over a more public model label", () => {
    const resolved = resolveSensitivity({
      connector_floor: "personal",
      connector_default: "personal",
      model_label: "public",
    });
    expect(resolved.sensitivity).toBe("personal");
    expect(resolved.refinement).toBe("rejected_downward");
  });

  test("a model label may only raise sensitivity", () => {
    const raised = resolveSensitivity({
      connector_floor: "public",
      connector_default: "public",
      model_label: "private",
    });
    expect(raised.sensitivity).toBe("private");
    expect(raised.refinement).toBe("applied");

    const rejected = resolveSensitivity({
      connector_floor: "public",
      connector_default: "personal",
      model_label: "public",
    });
    expect(rejected.sensitivity).toBe("personal");
    expect(rejected.refinement).toBe("rejected_downward");
  });

  test("an unknown or missing label resolves to private", () => {
    expect(resolveSensitivity({}).sensitivity).toBe("private");
    expect(resolveSensitivity({ connector_default: "secret" }).sensitivity).toBe(
      "private",
    );
    expect(resolveSensitivity({ connector_floor: null }).sensitivity).toBe(
      "private",
    );
    expect(resolveSensitivity({ model_label: "" }).sensitivity).toBe("private");
  });

  test("a health connector can never produce a public claim", () => {
    const policy = policyForSourceClass("health_biometrics");
    expect(policy).toEqual({
      default_sensitivity: "private",
      sensitivity_floor: "private",
    });
    const resolved = resolveSensitivity({
      connector_floor: policy.sensitivity_floor,
      connector_default: policy.default_sensitivity,
      model_label: "public",
      event_hint: "public",
    });
    expect(resolved.sensitivity).toBe("private");
    expect(resolved.refinement).toBe("rejected_downward");
    expect(resolved.hint_ignored).toBe(true);
  });

  test("an event hint is honored only upward", () => {
    const raised = resolveSensitivity({
      connector_floor: "public",
      connector_default: "public",
      event_hint: "personal",
    });
    expect(raised.sensitivity).toBe("personal");
    expect(raised.hint_ignored).toBe(false);

    const ignored = resolveSensitivity({
      connector_floor: "personal",
      connector_default: "private",
      event_hint: "public",
    });
    expect(ignored.sensitivity).toBe("private");
    expect(ignored.hint_ignored).toBe(true);
  });

  test("owner correction may lower the label", () => {
    const resolved = resolveSensitivity({
      connector_floor: "private",
      connector_default: "private",
      owner_label: "public",
      owner_override: true,
    });
    expect(resolved.sensitivity).toBe("public");
    expect(resolved.owner_override).toBe(true);
  });
});

describe("connector_sensitivity table", () => {
  test("seeds from a manifest and will not lower the floor", () => {
    const db = claimsDb();
    const connection = {
      connector_id: "kizuki.markdown-folder",
      source_key: "01JJ0000000000000000000001",
    };
    const seeded = seedConnectorSensitivity(db, connection, {
      default_sensitivity: "private",
      sensitivity_floor: "personal",
    });
    expect(seeded).toMatchObject({
      connector_id: connection.connector_id,
      source_key: connection.source_key,
      default_sensitivity: "private",
      floor: "personal",
      set_by: "manifest",
    });
    expect(
      getConnectorSensitivity(db, connection.connector_id, connection.source_key),
    ).toEqual(seeded);

    const raised = raiseConnectorSensitivityFloor(
      db,
      connection,
      "private",
      "personal",
    );
    expect(raised.floor).toBe("private");
    expect(raised.set_by).toBe("connect");

    expect(() =>
      raiseConnectorSensitivityFloor(db, connection, "public", "personal"),
    ).toThrow(SensitivityError);
    expect(() =>
      raiseConnectorSensitivityFloor(db, connection, "personal", "personal"),
    ).toThrow(/floor_below_current/);
    db.close();
  });

  test("applyConnectionSensitivity is idempotent on reconnect", () => {
    const db = claimsDb();
    const connection = {
      connector_id: "kizuki.import-chatgpt",
      source_key: "01JJ0000000000000000000002",
    };
    const first = applyConnectionSensitivity(db, connection, {
      default_sensitivity: "private",
      sensitivity_floor: "personal",
    });
    const second = applyConnectionSensitivity(db, connection, {
      default_sensitivity: "private",
      sensitivity_floor: "personal",
    });
    expect(second).toEqual(first);
    db.close();
  });
});

describe("insertClaim labels at write time", () => {
  test("a health fixture can never be public", async () => {
    const db = claimsDb();
    const eventId = putEvent(db, { connector_id: "health-fixture" });
    seedConnectorSensitivity(
      db,
      { connector_id: "health-fixture", source_key: "01JJ0000000000000000000003" },
      policyForSourceClass("health_biometrics"),
    );

    const stored = await insertClaim(
      { db },
      claimInput(eventId, {
        producer: "model",
        sensitivity: "public",
        events: [eventFacts(eventId, { connector_id: "health-fixture" })],
      }),
    );
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") return;
    expect(stored.claim.sensitivity).toBe("private");
    expect(getClaim(db, stored.claim.claim_id)?.sensitivity).toBe("private");
    db.close();
  });

  test("a model label raises a public-posts default to private", async () => {
    const db = claimsDb();
    const eventId = putEvent(db, { connector_id: "public-posts-fixture" });
    seedConnectorSensitivity(
      db,
      {
        connector_id: "public-posts-fixture",
        source_key: "01JJ0000000000000000000004",
      },
      policyForSourceClass("public_posts"),
    );

    const stored = await insertClaim(
      { db },
      claimInput(eventId, {
        producer: "model",
        sensitivity: "private",
        events: [eventFacts(eventId, { connector_id: "public-posts-fixture" })],
      }),
    );
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") return;
    expect(stored.claim.sensitivity).toBe("private");
    db.close();
  });

  test("labelClaimSensitivity records a rejected downward model label", () => {
    const db = claimsDb();
    seedConnectorSensitivity(
      db,
      { connector_id: "kizuki.screenpipe", source_key: "01JJ0000000000000000000005" },
      { default_sensitivity: "private", sensitivity_floor: "personal" },
    );
    const labeled = labelClaimSensitivity(db, {
      connector_ids: ["kizuki.screenpipe"],
      model_label: "public",
    });
    expect(labeled.sensitivity).toBe("private");
    expect(labeled.refinement).toBe("rejected_downward");
    db.close();
  });
});

describe("OWNER_AGENT_GRANT", () => {
  test("the owner-agent preset is private while the default stays personal", () => {
    expect(DEFAULT_GRANT.ceiling).toBe("personal");
    expect(OWNER_AGENT_GRANT.ceiling).toBe("private");
    expect(OWNER_AGENT_GRANT.tools).toEqual(DEFAULT_GRANT.tools);

    const db = agentsDb();
    const created = addAgent(db, "home-harness", OWNER_AGENT_GRANT);
    expect(created.agent.name).toBe("home-harness");
    db.close();
  });
});
