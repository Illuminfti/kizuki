import {
  addAgent,
  authenticate,
  serveContextPacket,
  runBackfill,
} from "../src/index";
import { claimReader } from "../src/serving/claims";
import type { Connector } from "../src/contracts/connector";
import {
  MODEL_PRODUCER_DESCRIPTOR,
  exportVault,
  restoreVault,
  bindLocalSourcePort,
  insertClaim,
} from "../src/index";
import { mineLiveDrafts } from "../src/serve/extract";
import { claimInput, FixtureVectorPort } from "./claims/helpers";
import type { ProducerPort, ProduceInput } from "../src/contracts/producer";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept,
  openLedger,
  registerConnection,
  disconnect,
  initVault,
  OWNER,
  serveTimeline,
  setSourceGrant,
  inspectSourceGrant,
  revokeSourceGrant,
  resumeSourceRevocation,
  sourcePolicyEpoch,
} from "../src/index";
import { validEvent } from "./fixtures";
import { ulid } from "../src/util/ulid";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "source-grants-"));
  dirs.push(dir);
  initVault(dir);
  const db = openLedger(join(dir, ".kizuki", "kizuki.db"));
  const a = ulid();
  const b = ulid();
  registerConnection(db, "kizuki.fixture", a);
  registerConnection(db, "kizuki.fixture", b);
  return { dir, db, a, b };
}
function policy() {
  return {
    purposes: ["capture", "recall", "session", "derive", "extract", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked",
    egress: "local_only",
    sensitivity_floor: "private",
  };
}
function grant(db: ReturnType<typeof openLedger>, key: string) {
  return setSourceGrant(db, {
    source_key: key,
    expected_revision: 0,
    operation_id: "grant-a",
    policy: policy(),
  });
}
function event() {
  return {
    ...validEvent(),
    connector_id: "kizuki.fixture",
    text: "Synthetic source evidence.",
  };
}

describe("durable source grants", () => {
  test("grant revision and retry are durable, while unbound metadata cannot claim a source", () => {
    const { dir, db, a, b } = setup();
    expect(sourcePolicyEpoch(db)).toBe(0);
    const receipt = grant(db, a);
    expect(sourcePolicyEpoch(db)).toBeGreaterThan(0);
    expect(grant(db, a)).toEqual(receipt);
    expect(() =>
      setSourceGrant(db, {
        source_key: a,
        expected_revision: 0,
        operation_id: "grant-a",
        policy: { ...policy(), purposes: ["capture"] },
      }),
    ).toThrow("operation_conflict");
    expect(
      accept(db, event(), {
        source: { source_key: a, expected_revision: receipt.revision },
      }).status,
    ).toBe("stored");
    expect(
      accept(db, event(), { source: { source_key: b, expected_revision: 1 } })
        .status,
    ).toBe("error");
    const legacy = accept(db, {
      ...event(),
      source_record_id: "legacy",
      metadata: { source_key: a },
    });
    expect(legacy.status).toBe("stored");
    db.close();
    const reopened = openLedger(join(dir, ".kizuki", "kizuki.db"));
    try {
      expect(grant(reopened, a)).toEqual(receipt);
      expect(inspectSourceGrant(reopened, a)?.revision).toBe(1);
    } finally {
      reopened.close();
    }
  });
  test("capture respects allowed fields, floor, retention and stale revisions", () => {
    const { db, a } = setup();
    try {
      expect(() =>
        setSourceGrant(db, {
          source_key: a,
          expected_revision: 0,
          operation_id: "invalid",
          policy: { ...policy(), retention: "derived_until_revoked" },
        }),
      ).toThrow("unsupported_retention");
      const receipt = setSourceGrant(db, {
        source_key: a,
        expected_revision: 0,
        operation_id: "fields",
        policy: { ...policy(), allowed_fields: ["text"] },
      });
      expect(
        accept(db, event(), {
          source: { source_key: a, expected_revision: receipt.revision },
        }).status,
      ).toBe("error");
      const accepted = accept(
        db,
        { ...event(), subjects: [], attachments: [], metadata: {} },
        { source: { source_key: a, expected_revision: receipt.revision } },
      );
      expect(accepted.status).toBe("stored");
      if (accepted.status === "stored")
        expect(accepted.event.sensitivity_hint).toBe("private");
      expect(
        accept(db, event(), { source: { source_key: a, expected_revision: 0 } })
          .status,
      ).toBe("error");
    } finally {
      db.close();
    }
  });
  test("deny precedes physical purge, persists across reopen, and disconnect does not revoke", async () => {
    const { dir, db, a, b } = setup();
    grant(db, a);
    setSourceGrant(db, {
      source_key: b,
      expected_revision: 0,
      operation_id: "grant-b",
      policy: policy(),
    });
    const first = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    const other = accept(
      db,
      { ...event(), source_record_id: "other" },
      { source: { source_key: b, expected_revision: 1 } },
    );
    expect(first.status).toBe("stored");
    expect(other.status).toBe("stored");
    disconnect(db, "kizuki.fixture", b);
    expect(inspectSourceGrant(db, b)?.status).toBe("active");
    const denied = revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "revoke-a",
    });
    expect(denied.status).toBe("denied");
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 2,
    });
    const read = serveTimeline(
      { db, vaultPath: dir, principal: OWNER },
      { since: "2000-01-01T00:00:00Z", until: "2100-01-01T00:00:00Z" },
    );
    expect(read.quoted.map((item) => item.event_id)).not.toContain(
      first.status === "stored" ? first.event.event_id : "",
    );
    db.close();
    const reopened = openLedger(join(dir, ".kizuki", "kizuki.db"));
    try {
      expect(inspectSourceGrant(reopened, a)?.status).toBe("denied");
      const completed = await resumeSourceRevocation(reopened, dir, "revoke-a");
      expect(completed.status).toBe("purged");
      expect(reopened.query("SELECT count(*) AS n FROM events").get()).toEqual({
        n: 1,
      });
    } finally {
      reopened.close();
    }
  });
});

describe("source policy consumer boundaries", () => {
  test("backup preserves the policy epoch and source binding, and refuses denied payload", () => {
    const { db, dir, a } = setup();
    try {
      grant(db, a);
      expect(
        accept(db, event(), { source: { source_key: a, expected_revision: 1 } })
          .status,
      ).toBe("stored");
      const backup = join(dir, "..", `${a}-backup`);
      dirs.push(backup);
      const restored = join(dir, "..", `${a}-restored`);
      dirs.push(restored);
      exportVault(db, dir, backup);
      restoreVault(backup, restored);
      const copy = openLedger(join(restored, ".kizuki", "kizuki.db"));
      try {
        expect(sourcePolicyEpoch(copy)).toBe(sourcePolicyEpoch(db));
        expect(inspectSourceGrant(copy, a)).toEqual(inspectSourceGrant(db, a));
        expect(
          copy.query("SELECT count(*) AS n FROM source_event_bindings").get(),
        ).toEqual({ n: 1 });
      } finally {
        copy.close();
      }
      revokeSourceGrant(db, {
        source_key: a,
        expected_revision: 1,
        operation_id: "deny-export",
      });
      expect(() => exportVault(db, dir, backup + "-denied")).toThrow(
        "source_export_denied",
      );
    } finally {
      db.close();
    }
  });
  test("local extraction excludes unbound context and refuses unknown egress or delayed revocation", async () => {
    const { db, a } = setup();
    try {
      grant(db, a);
      const input = accept(db, event(), {
        source: { source_key: a, expected_revision: 1 },
      });
      if (input.status !== "stored") throw new Error("fixture failed");
      const legacy = accept(db, {
        ...event(),
        source_record_id: "legacy-context",
      });
      if (legacy.status !== "stored") throw new Error("fixture failed");
      await insertClaim({ db }, claimInput(legacy.event.event_id));
      let calls = 0;
      const producer: ProducerPort = {
        descriptor: MODEL_PRODUCER_DESCRIPTOR,
        health: async () => ({ status: "ready", detail: {} }),
        close: async () => {},
        produce: async (request: ProduceInput) => {
          calls++;
          expect(request.events.map((e) => e.event_id)).toEqual([
            input.event.event_id,
          ]);
          expect(request.context.known_claims).toEqual([]);
          revokeSourceGrant(db, {
            source_key: a,
            expected_revision: 1,
            operation_id: "during-model",
          });
          return {
            status: "ok" as const,
            claims: [],
            usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
          };
        },
      };
      expect((await mineLiveDrafts(db, producer)).mined.status).toBe(
        "unavailable",
      );
      expect(calls).toBe(0);
      bindLocalSourcePort(producer);
      expect((await mineLiveDrafts(db, producer)).mined.status).toBe(
        "unavailable",
      );
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });
});

test("new enrollment refuses acquisition before consent; enrolled run binds events atomically", async () => {
  const { db, a } = setup();
  try {
    let acquired = 0;
    const connector = {
      manifest: () => ({
        schema: "kizuki.connector/v1",
        connector_id: "kizuki.fixture",
        version: "1",
        kinds: ["message"],
        capabilities: { backfill: true },
        required_secrets: [],
        emits_sensitivity_hint: true,
        auth_modes: ["none"],
      }),
      backfill: async () => {
        acquired++;
        return { events: [event()], cursor: null };
      },
    } as unknown as Connector;
    expect(
      (await runBackfill(db, connector, "kizuki.fixture", a)).errors,
    ).toEqual(["source_capture_denied"]);
    expect(acquired).toBe(0);
    grant(db, a);
    expect((await runBackfill(db, connector, "kizuki.fixture", a)).stored).toBe(
      1,
    );
    expect(acquired).toBe(1);
    expect(
      db.query("SELECT source_key FROM source_event_bindings").get(),
    ).toEqual({ source_key: a });
  } finally {
    db.close();
  }
});

test("native serving denies legacy agent access, honors purpose and invalidates cached packet epoch", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a);
    const managed = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    const legacy = accept(db, { ...event(), source_record_id: "owner-only" });
    if (managed.status !== "stored" || legacy.status !== "stored")
      throw new Error("fixture failed");
    const principal = authenticate(
      db,
      addAgent(db, "synthetic-reader", {
        ceiling: "private",
        tools: ["timeline", "context_packet"],
      }).token,
    )!;
    const window = {
      since: "2000-01-01T00:00:00Z",
      until: "2100-01-01T00:00:00Z",
    };
    const owner = { db, vaultPath: dir, principal: OWNER };
    const client = { ...owner, principal };
    expect(serveTimeline(owner, window).quoted).toHaveLength(2);
    expect(serveTimeline(client, window).quoted.map((e) => e.event_id)).toEqual(
      [managed.event.event_id],
    );
    const packet = await serveContextPacket(owner, {
      query: "Synthetic",
      budget_tokens: 500,
    });
    const epoch = packet.data!.claims_epoch;
    setSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "capture-only",
      policy: { ...policy(), purposes: ["capture"] },
    });
    expect(serveTimeline(owner, window).quoted.map((e) => e.event_id)).toEqual([
      legacy.event.event_id,
    ]);
    expect(
      (
        await serveContextPacket(owner, {
          query: "Synthetic",
          budget_tokens: 500,
        })
      ).data!.claims_epoch,
    ).toBeGreaterThan(epoch);
    expect(serveTimeline(owner, window).source_policy?.legacy_unbound).toBe(
      "owner_only",
    );
  } finally {
    db.close();
  }
});

test("mixed derived provenance is denied after one source revokes, without changing unrelated source", async () => {
  const { db, a, b } = setup();
  try {
    grant(db, a);
    setSourceGrant(db, {
      source_key: b,
      expected_revision: 0,
      operation_id: "grant-b",
      policy: policy(),
    });
    const first = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    const second = accept(
      db,
      { ...event(), source_record_id: "b-event" },
      { source: { source_key: b, expected_revision: 1 } },
    );
    if (first.status !== "stored" || second.status !== "stored")
      throw new Error("fixture failed");
    const input = claimInput(first.event.event_id, {
      provenance: [first.event.event_id, second.event.event_id],
    });
    const stored = await insertClaim({ db }, input);
    if (!("claim" in stored)) throw new Error("fixture unexpectedly contested");
    const reader = claimReader(db, OWNER.grant);
    expect(reader.canRead(stored.claim)).toBe(true);
    const request = {
      source_key: a,
      expected_revision: 1,
      operation_id: "mixed-denial",
    };
    expect(revokeSourceGrant(db, request)).toEqual(
      revokeSourceGrant(db, request),
    );
    expect(reader.canRead(stored.claim)).toBe(false);
    await expect(
      insertClaim({ db }, { ...input, body: "Another unsupported inference." }),
    ).rejects.toThrow("source_access_denied");
    expect(inspectSourceGrant(db, b)?.status).toBe("active");
  } finally {
    db.close();
  }
});

test("revocation stays denied while a derived write is in flight and removes its late result", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a);
    const input = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    if (input.status !== "stored") throw new Error("fixture failed");
    const port = bindLocalSourcePort(new FixtureVectorPort({ vector: false }));
    const original = port.upsert.bind(port);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    port.upsert = async (docs) => {
      started();
      await waiting;
      return original(docs);
    };
    const filing = insertClaim(
      { db, retrieval: port },
      claimInput(input.event.event_id),
    );
    await entered;
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "revoke-inflight",
    });
    expect(
      (
        await resumeSourceRevocation(db, dir, "revoke-inflight", {
          retrieval: port,
        })
      ).status,
    ).toBe("denied");
    release();
    await filing;
    expect(port.docs.size).toBe(0);
    const remaining = await resumeSourceRevocation(db, dir, "revoke-inflight", {
      retrieval: port,
    });
    expect(remaining.status).toBe("denied");
    expect(remaining.purge_blockers).toEqual(["claim_payload_retained"]);
    expect(db.query("SELECT state FROM retrieval_ops").get()).toEqual({
      state: "cancelled",
    });
  } finally {
    db.close();
  }
});
