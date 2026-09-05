import { rebuildRetrieval, type RetrievalPort } from "../src/index";
import { undoReceipt } from "../src/index";
import { write, storeClaim } from "./canon/helpers";
import { serveGetPage } from "../src/index";
import { page } from "./serving/helpers";
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
      expect(completed.status).toBe("denied");
      expect(completed.purge_blockers).toContain("owned_retrieval_pending");
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
    const port = bindLocalSourcePort(new FixtureVectorPort({ vector: false }), {
      store_id: "local:fixture",
    });
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
    expect(remaining.purge_blockers).not.toContain("claim_payload_retained");
    expect(remaining.purge_blockers).toContain("owned_retrieval_pending");
    expect(db.query("SELECT state FROM retrieval_ops").get()).toEqual({
      state: "cancelled",
    });
  } finally {
    db.close();
  }
});

test("native resume cannot drop a revoked citation and expose surviving mixed canon text", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a);
    setSourceGrant(db, {
      source_key: b,
      expected_revision: 0,
      operation_id: "mixed-b",
      policy: policy(),
    });
    const first = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    const second = accept(
      db,
      { ...event(), source_record_id: "mixed-b-event" },
      { source: { source_key: b, expected_revision: 1 } },
    );
    if (first.status !== "stored" || second.status !== "stored")
      throw new Error("fixture failed");
    page(
      dir,
      "facts/mixed.md",
      {
        id: "fact:mixed",
        title: "Synthetic mixed evidence",
        type: "fact",
        status: "active",
        sensitivity: "private",
        taint: "clean",
        sources: [first.event.event_id, second.event.event_id],
      },
      "Synthetic mixed source text.",
    );
    const owner = { db, vaultPath: dir, principal: OWNER };
    expect(serveGetPage(owner, { id: "fact:mixed" }).canon).toHaveLength(1);
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "mixed-canon",
    });
    expect((await resumeSourceRevocation(db, dir, "mixed-canon")).status).toBe(
      "denied",
    );
    expect(serveGetPage(owner, { id: "fact:mixed" }).canon).toHaveLength(0);
    expect(inspectSourceGrant(db, a)?.purge_blockers).toContain(
      "canon_rewrite_pending",
    );
  } finally {
    db.close();
  }
});

test("undo cannot restore an archive whose source authorization was revoked", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a);
    const input = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    if (input.status !== "stored") throw new Error("fixture failed");
    const io = { db, vault_path: dir };
    write(io, await storeClaim(db, input.event.event_id));
    const edited = write(
      io,
      await storeClaim(db, input.event.event_id, {
        kind: "edit",
        predicate: null,
        object: null,
        body: "A second synthetic observation.",
        frontmatter: { title: "Synthetic revision" },
      }),
    );
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "deny-undo",
    });
    await expect(undoReceipt(io, edited.receipt_id)).rejects.toThrow(
      "source_access_denied",
    );
  } finally {
    db.close();
  }
});

test("retained non-body claim payload cannot produce a completed purge", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a);
    const input = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    if (input.status !== "stored") throw new Error("fixture failed");
    await insertClaim(
      { db },
      claimInput(input.event.event_id, {
        kind: "entity",
        body: "",
        object: null,
        predicate: null,
        target: "private-target",
        subject: "person:private-subject",
        subjects: ["person:private-subject"],
        frontmatter: { title: "private title" },
        model_ref: "private-model-reference",
      }),
    );
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "residual-payload",
    });
    const result = await resumeSourceRevocation(db, dir, "residual-payload");
    expect(result.status).toBe("denied");
    expect(result.purge_blockers).not.toContain("claim_payload_retained");
    expect(
      db.query("SELECT subject,target,frontmatter,model_ref FROM claims").get(),
    ).toEqual({
      subject: null,
      target: null,
      frontmatter: "{}",
      model_ref: null,
    });
  } finally {
    db.close();
  }
});

test("operation retry refuses corrupted persisted receipt shape and intent", () => {
  const { db, a } = setup();
  try {
    const original = grant(db, a);
    for (const corrupt of [
      { status: "active", revision: 999, injected: "not a receipt" },
      { ...original, revision: original.revision + 1 },
      { ...original, source_key: ulid() },
    ]) {
      db.query(
        "UPDATE source_grant_receipts SET receipt=? WHERE operation_id=?",
      ).run(JSON.stringify(corrupt), original.operation_id);
      expect(() => grant(db, a)).toThrow("source_receipt_corrupt");
    }
  } finally {
    db.close();
  }
});

test("an in-flight rebuild fences purge and verifies removal after revocation", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a);
    const input = accept(db, event(), {
      source: { source_key: a, expected_revision: 1 },
    });
    if (input.status !== "stored") throw new Error("fixture failed");
    const port = bindLocalSourcePort(new FixtureVectorPort({ vector: false }), {
      store_id: "local:fixture",
    }) as FixtureVectorPort & {
      rebuildFromDocuments: NonNullable<RetrievalPort["rebuildFromDocuments"]>;
    };
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    port.rebuildFromDocuments = async (docs) => {
      const rows = [];
      for await (const doc of docs) rows.push(doc);
      started();
      await waiting;
      port.docs.clear();
      await port.upsert(rows);
    };
    const rebuilding = rebuildRetrieval(db, dir, port).then(
      () => null,
      (error) => error as Error,
    );
    await entered;
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "rebuild-denial",
    });
    expect(
      (
        await resumeSourceRevocation(db, dir, "rebuild-denial", {
          retrieval: port,
        })
      ).status,
    ).toBe("denied");
    release();
    expect((await rebuilding)?.message).toContain(
      "source authorization changed",
    );
    expect(
      (await port.verifyAbsent([`event:${input.event.event_id}`])).found,
    ).toEqual([]);
    expect(port.docs.size).toBe(0);
  } finally {
    db.close();
  }
});

test("rebuild timeout retains its fence until the late operation is removed and verified", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a);
    expect(
      accept(db, event(), { source: { source_key: a, expected_revision: 1 } })
        .status,
    ).toBe("stored");
    const port = bindLocalSourcePort(new FixtureVectorPort({ vector: false }), {
      store_id: "local:fixture",
    }) as FixtureVectorPort & {
      rebuildFromDocuments: NonNullable<RetrievalPort["rebuildFromDocuments"]>;
    };
    Object.assign(port.descriptor, {
      method_timeouts_ms: { rebuildFromDocuments: 15 },
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    port.rebuildFromDocuments = async (docs) => {
      const rows = [];
      for await (const doc of docs) rows.push(doc);
      await waiting;
      await port.upsert(rows);
    };
    const error = await rebuildRetrieval(db, dir, port).then(
      () => null,
      (error) => error as Error,
    );
    expect(error?.message).toContain("writer remains fenced");
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "timeout-denial",
    });
    expect(
      (await resumeSourceRevocation(db, dir, "timeout-denial")).purge_blockers,
    ).toContain("writer_busy");
    release();
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const result = await resumeSourceRevocation(db, dir, "timeout-denial");
      if (!result.purge_blockers.includes("writer_busy")) {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    expect(port.docs.size).toBe(0);
  } finally {
    db.close();
  }
});

test("a crashed rebuild releases kernel ownership and reopened source revocation can resume", async () => {
  const { db, dir, a } = setup();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    grant(db, a);
    expect(
      accept(db, event(), { source: { source_key: a, expected_revision: 1 } })
        .status,
    ).toBe("stored");
    const sourceModule = new URL("../src/index.ts", import.meta.url).pathname;
    const fixtureModule = new URL("./claims/helpers.ts", import.meta.url)
      .pathname;
    const script = `import { openLedger, bindLocalSourcePort, rebuildRetrieval } from ${JSON.stringify(sourceModule)};
      import { FixtureVectorPort } from ${JSON.stringify(fixtureModule)};
      const dir=${JSON.stringify(dir)};
      const db=openLedger(dir+'/.kizuki/kizuki.db');
      const port=bindLocalSourcePort(new FixtureVectorPort({vector:false}),{store_id:"local:fixture"});
      port.rebuildFromDocuments=async()=>{ process.stdout.write('ready\\n'); await new Promise(()=>{}); };
      await rebuildRetrieval(db,dir,port);`;
    child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stream = child.stdout as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    revokeSourceGrant(db, {
      source_key: a,
      expected_revision: 1,
      operation_id: "crash-denial",
    });
    expect(
      (await resumeSourceRevocation(db, dir, "crash-denial")).purge_blockers,
    ).toContain("writer_busy");
    child.kill("SIGKILL");
    await child.exited;
    child = undefined;
    db.close();
    const reopened = openLedger(join(dir, ".kizuki", "kizuki.db"));
    try {
      expect(
        (await resumeSourceRevocation(reopened, dir, "crash-denial"))
          .purge_blockers,
      ).not.toContain("writer_busy");
    } finally {
      reopened.close();
    }
  } finally {
    if (child !== undefined) {
      child.kill("SIGKILL");
      await child.exited;
    }
    try {
      db.close();
    } catch {}
  }
});

test("native relayed corrections preserve owner origin and source closure across retry and restore", async () => {
  const { db, dir, a } = setup();
  setSourceGrant(db, {
    source_key: a,
    expected_revision: 0,
    operation_id: "correction-grant",
    policy: { ...policy(), purposes: [...policy().purposes, "correction"] },
  });
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture admission failed");
  const target = await insertClaim(
    { db },
    {
      ...claimInput(accepted.event.event_id),
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Acme",
      subjects: ["person:ada"],
    },
  );
  if (!("claim" in target)) throw new Error("fixture claim failed");
  const principal = authenticate(
    db,
    addAgent(db, "source-relay", {
      ceiling: "private",
      tools: ["correct"],
      relay_owner_corrections: true,
    }).token,
  )!;
  const { serveCorrect } = await import("../src/index");
  const args = {
    statement: "Ada left Acme.",
    target: { claim_id: target.claim.claim_id },
  };
  const result = await serveCorrect({ db, vaultPath: dir, principal }, args);
  expect(result.data!.event_id).not.toBeNull();
  const stored = db
    .query<{ provenance: string }, [string]>(
      "SELECT provenance FROM claims WHERE claim_id=?",
    )
    .get(result.data!.claim_id!);
  expect(JSON.parse(stored!.provenance)).toContain(accepted.event.event_id);
  expect(
    db
      .query("SELECT filing_state FROM native_owner_evidence WHERE event_id=?")
      .get(result.data!.event_id!),
  ).toEqual({ filing_state: "filed" });
  const replay = await serveCorrect({ db, vaultPath: dir, principal }, args);
  expect(replay.data!.event_id).toBe(result.data!.event_id);
  await expect(
    serveCorrect(
      { db, vaultPath: dir, principal },
      { ...args, object: "Other" },
    ),
  ).rejects.toThrow();
  const roundtrip = mkdtempSync(join(tmpdir(), "origin-roundtrip-"));
  dirs.push(roundtrip);
  const backup = join(roundtrip, "backup");
  exportVault(db, dir, backup);
  const restored = join(roundtrip, "restored");
  await restoreVault(backup, restored);
  const reopened = openLedger(join(restored, ".kizuki", "kizuki.db"));
  expect(
    reopened
      .query("SELECT filing_state FROM native_owner_evidence WHERE event_id=?")
      .get(result.data!.event_id!),
  ).toEqual({ filing_state: "filed" });
  reopened.close();
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "origin-revoke",
  });
  expect(
    claimReader(db, OWNER.grant).canRead(
      JSON.parse(JSON.stringify(target.claim)),
    ),
  ).toBe(false);
  expect(
    db
      .query("SELECT 1 FROM events WHERE event_id=?")
      .get(result.data!.event_id!),
  ).not.toBeNull();
  db.close();
});

test("a failed native correction has a durable recording receipt and can retry after reopen", async () => {
  const { db, dir, a } = setup();
  setSourceGrant(db, {
    source_key: a,
    expected_revision: 0,
    operation_id: "failed-correction-grant",
    policy: { ...policy(), purposes: [...policy().purposes, "correction"] },
  });
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const target = await insertClaim({ db }, claimInput(accepted.event.event_id));
  if (!("claim" in target)) throw new Error("fixture claim failed");
  const { serveCorrect } = await import("../src/index");
  const args = {
    statement: "The recorded employer is wrong.",
    target: { claim_id: target.claim.claim_id },
  };
  db.exec(
    "CREATE TRIGGER refuse_fixture_correction BEFORE INSERT ON claims WHEN NEW.target LIKE 'correction:%' BEGIN SELECT RAISE(FAIL, 'synthetic filing failure'); END",
  );
  await expect(
    serveCorrect({ db, vaultPath: dir, principal: OWNER }, args),
  ).rejects.toThrow("serving failed");
  const recorded = db
    .query<{ event_id: string; filing_state: string }, []>(
      "SELECT event_id,filing_state FROM native_owner_evidence",
    )
    .get()!;
  expect(recorded.filing_state).toBe("failed");
  expect(
    db.query("SELECT 1 FROM events WHERE event_id=?").get(recorded.event_id),
  ).not.toBeNull();
  db.exec("DROP TRIGGER refuse_fixture_correction");
  db.close();
  const reopened = openLedger(join(dir, ".kizuki", "kizuki.db"));
  const retried = await serveCorrect(
    { db: reopened, vaultPath: dir, principal: OWNER },
    args,
  );
  expect(retried.data!.event_id).toBe(recorded.event_id);
  expect(
    reopened.query("SELECT count(*) AS n FROM native_owner_evidence").get(),
  ).toEqual({ n: 1 });
  reopened.close();
});

test("historical owned retrieval stores remain pending until inventory verifies and physically maintains them", async () => {
  const { db, dir, a } = setup();
  grant(db, a);
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const old: FixtureVectorPort & RetrievalPort = new FixtureVectorPort();
  old.rebuildFromDocuments = async (docs) => {
    old.docs.clear();
    for await (const doc of docs) await old.upsert([doc]);
  };
  bindLocalSourcePort(old, { store_id: "local:fixture-old" });
  await rebuildRetrieval(db, dir, old);
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "old-store-revoke",
  });
  const pending = await resumeSourceRevocation(db, dir, "old-store-revoke");
  expect(pending.status).toBe("denied");
  expect(pending.purge_blockers).toContain("owned_retrieval_pending");
  expect(old.docs.size).toBeGreaterThan(0);
  let maintained = false;
  const cleared = await resumeSourceRevocation(db, dir, "old-store-revoke", {
    ownedRetrieval: {
      stores: async () => ({
        stores: [
          {
            id: "local:fixture-old",
            port: old,
            maintain: async () => {
              expect(old.docs.size).toBe(0);
              maintained = true;
              return { owned_file_maintenance: "complete" as const };
            },
          },
        ],
        absent_store_ids: [],
      }),
    },
  });
  expect(maintained).toBe(true);
  expect(cleared.owned_retrieval).toContainEqual({
    store_id: "local:fixture-old",
    status: "maintained",
  });
  db.close();
});

test("owned-store omission is not absence and broken stores can be erased through trusted maintenance only", async () => {
  const { db, dir, a } = setup();
  grant(db, a);
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const port: FixtureVectorPort & RetrievalPort = new FixtureVectorPort();
  port.rebuildFromDocuments = async (docs) => {
    for await (const doc of docs) await port.upsert([doc]);
  };
  bindLocalSourcePort(port, { store_id: "local:broken" });
  await rebuildRetrieval(db, dir, port);
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "broken-revoke",
  });
  const omitted = await resumeSourceRevocation(db, dir, "broken-revoke", {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  });
  expect(omitted.owned_retrieval).toEqual([
    { store_id: "local:broken", status: "pending" },
  ]);
  const erased = await resumeSourceRevocation(db, dir, "broken-revoke", {
    ownedRetrieval: {
      stores: async () => ({
        stores: [
          {
            id: "local:broken",
            maintain: async () => {
              port.docs.clear();
              return { owned_file_maintenance: "complete" };
            },
          },
        ],
        absent_store_ids: [],
      }),
    },
  });
  expect(erased.owned_retrieval).toEqual([
    { store_id: "local:broken", status: "maintained" },
  ]);
  expect(erased.status).toBe("purged");
  db.close();
});

test("native source erasure removes whole joint claims and SQLite payload while preserving independent evidence", async () => {
  const { db, dir, a, b } = setup();
  grant(db, a);
  setSourceGrant(db, {
    source_key: b,
    expected_revision: 0,
    operation_id: "grant-b-physical",
    policy: policy(),
  });
  const secret = "qzxsourceeraseuniquesyntheticpayload5817";
  const aa = accept(
    db,
    { ...event(), source_record_id: "a-physical", text: secret },
    { source: { source_key: a, expected_revision: 1 } },
  );
  const bb = accept(
    db,
    {
      ...event(),
      source_record_id: "b-physical",
      text: "Independent B evidence",
    },
    { source: { source_key: b, expected_revision: 1 } },
  );
  if (aa.status !== "stored" || bb.status !== "stored")
    throw new Error("fixture failed");
  const joint = await insertClaim(
    { db },
    claimInput(aa.event.event_id, {
      body: secret,
      subject: secret,
      subjects: [secret],
      object: secret,
      target: secret,
      frontmatter: { title: secret },
      provenance: [aa.event.event_id, bb.event.event_id],
    }),
  );
  const independent = await insertClaim(
    { db },
    claimInput(bb.event.event_id, {
      body: "Independent B claim",
      subject: "person:b",
      subjects: ["person:b"],
      object: "B employer",
    }),
  );
  if (!("claim" in joint) || !("claim" in independent))
    throw new Error("fixture claim failed");
  await rebuildRetrieval(db, dir);
  expect(
    db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM search_docs WHERE search_docs MATCH ?",
      )
      .get(secret)?.n,
  ).toBeGreaterThan(0);
  expect(
    db
      .query<{ block: Uint8Array }, []>("SELECT block FROM search_docs_data")
      .all()
      .some((row) => Buffer.from(row.block).includes(Buffer.from(secret))),
  ).toBe(true);
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "physical-revoke",
  });
  const done = await resumeSourceRevocation(db, dir, "physical-revoke", {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  });
  expect(done.status).toBe("purged");
  expect(done.erasure?.affected_claim_ids).toContain(joint.claim.claim_id);
  expect(
    db
      .query(
        "SELECT body,subject,object,target,frontmatter FROM claims WHERE claim_id=?",
      )
      .get(joint.claim.claim_id),
  ).toEqual({
    body: "",
    subject: null,
    object: null,
    target: null,
    frontmatter: "{}",
  });
  expect(
    db
      .query("SELECT body FROM claims WHERE claim_id=?")
      .get(independent.claim.claim_id),
  ).toEqual({ body: "Independent B claim" });
  expect(
    db.query("SELECT text FROM events WHERE event_id=?").get(bb.event.event_id),
  ).toEqual({ text: "Independent B evidence" });
  const { readFileSync, existsSync } = await import("node:fs");
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(dir, ".kizuki", "kizuki.db" + suffix);
    if (existsSync(path))
      expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  }
  db.close();
});

test("SQLite readers keep physical source completion pending until checkpoint can finish", async () => {
  const { db, dir, a } = setup();
  grant(db, a);
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const reader = openLedger(join(dir, ".kizuki", "kizuki.db"));
  reader.exec("BEGIN");
  reader.query("SELECT text FROM events").all();
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "reader-revoke",
  });
  const options = {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  };
  const pending = await resumeSourceRevocation(
    db,
    dir,
    "reader-revoke",
    options,
  );
  expect(pending.status).toBe("denied");
  expect(pending.erasure?.logical_absence).toBe(true);
  expect(pending.erasure?.owned_file_maintenance).toBe("pending");
  reader.exec("ROLLBACK");
  reader.close();
  const done = await resumeSourceRevocation(db, dir, "reader-revoke", options);
  expect(done.status).toBe("purged");
  expect(done.erasure?.owned_file_maintenance).toBe("complete");
  db.close();
});

test("source erasure removes receipted canon and its archive without making another preimage", async () => {
  const { db, dir, a } = setup();
  grant(db, a);
  const accepted = accept(
    db,
    { ...event(), text: "CANON_ERASURE_SYNTHETIC_713" },
    { source: { source_key: a, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const io = { db, vault_path: dir };
  const first = write(
    io,
    await storeClaim(db, accepted.event.event_id, {
      body: "CANON_ERASURE_SYNTHETIC_713",
      frontmatter: { type: "person", title: "CANON_ERASURE_SYNTHETIC_713" },
    }),
  );
  const second = write(
    io,
    await storeClaim(db, accepted.event.event_id, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "CANON_ERASURE_SYNTHETIC_713 revised",
      frontmatter: { title: "CANON_ERASURE_SYNTHETIC_713" },
    }),
  );
  expect(second.archive_path).not.toBeNull();
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "canon-erase",
  });
  const done = await resumeSourceRevocation(db, dir, "canon-erase", {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  });
  expect(done.status).toBe("purged");
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  expect(existsSync(join(dir, first.page_path))).toBe(false);
  expect(existsSync(join(dir, second.archive_path!))).toBe(false);
  expect(readdirSync(join(dir, "archive"))).toEqual([]);
  expect(
    readFileSync(join(dir, ".kizuki", "receipts", "promotions.jsonl"), "utf8"),
  ).not.toContain("CANON_ERASURE_SYNTHETIC_713");
  await expect(undoReceipt(io, first.receipt_id)).rejects.toThrow();
  const roundtrip = mkdtempSync(join(tmpdir(), "erased-canon-roundtrip-"));
  dirs.push(roundtrip);
  exportVault(db, dir, join(roundtrip, "backup"));
  restoreVault(join(roundtrip, "backup"), join(roundtrip, "restored"));
  const restoredDb = openLedger(
    join(roundtrip, "restored", ".kizuki", "kizuki.db"),
  );
  expect(inspectSourceGrant(restoredDb, a)?.status).toBe("purged");
  expect(
    restoredDb
      .query("SELECT body FROM claims")
      .all()
      .every((row) => (row as { body: string }).body === ""),
  ).toBe(true);
  restoredDb.close();
  db.close();
});

test("receipted mixed canon preserves independently supported B text and owner edits remain held", async () => {
  const { db, dir, a, b } = setup();
  grant(db, a);
  setSourceGrant(db, {
    source_key: b,
    expected_revision: 0,
    operation_id: "mixed-physical-b",
    policy: policy(),
  });
  const aa = accept(
    db,
    { ...event(), source_record_id: "mixed-physical-a" },
    { source: { source_key: a, expected_revision: 1 } },
  );
  const bb = accept(
    db,
    { ...event(), source_record_id: "mixed-physical-b" },
    { source: { source_key: b, expected_revision: 1 } },
  );
  if (aa.status !== "stored" || bb.status !== "stored")
    throw new Error("fixture failed");
  const io = { db, vault_path: dir };
  const first = write(
    io,
    await storeClaim(db, aa.event.event_id, {
      body: "A_ONLY_CANON_FRAGMENT_442",
      frontmatter: { type: "person", title: "Shared person" },
    }),
  );
  write(
    io,
    await storeClaim(db, bb.event.event_id, {
      kind: "merge",
      predicate: null,
      object: null,
      body: "B independently supported paragraph.",
      frontmatter: { type: "person", title: "Shared person" },
    }),
  );
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "mixed-physical-erase",
  });
  const done = await resumeSourceRevocation(db, dir, "mixed-physical-erase", {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  });
  expect(done.status).toBe("purged");
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(join(dir, first.page_path), "utf8");
  expect(text).toContain("B independently supported paragraph.");
  expect(text).not.toContain("A_ONLY_CANON_FRAGMENT_442");
  expect(text).not.toContain(aa.event.event_id);
  const { parseFrontmatter } = await import("../src/vault/frontmatter");
  const surviving = serveGetPage(
    { db, vaultPath: dir, principal: OWNER },
    { id: String(parseFrontmatter(text).data["id"]) },
  );
  expect(surviving.canon).toHaveLength(1);
  db.close();
});

test("owner-edited source canon remains byte-identical and held through revocation", async () => {
  const { db, dir, a } = setup();
  grant(db, a);
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const receipt = write(
    { db, vault_path: dir },
    await storeClaim(db, accepted.event.event_id),
  );
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = join(dir, receipt.page_path);
  const edited =
    readFileSync(path, "utf8") + "\nOwner-authored unrelated paragraph.\n";
  writeFileSync(path, edited);
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "owner-edited-revoke",
  });
  const pending = await resumeSourceRevocation(db, dir, "owner-edited-revoke", {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  });
  expect(pending.status).toBe("denied");
  expect(pending.erasure?.retained_reasons).toContain(
    "canon_or_archive_payload_retained",
  );
  expect(readFileSync(path, "utf8")).toBe(edited);
  db.close();
});

test("interrupted canon metadata erasure resumes without restoring a deleted preimage", async () => {
  const { db, dir, a } = setup();
  grant(db, a);
  const accepted = accept(db, event(), {
    source: { source_key: a, expected_revision: 1 },
  });
  if (accepted.status !== "stored") throw new Error("fixture failed");
  const receipt = write(
    { db, vault_path: dir },
    await storeClaim(db, accepted.event.event_id),
  );
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "interrupt-canon",
  });
  db.exec(
    "CREATE TRIGGER interrupt_source_metadata BEFORE UPDATE OF page_path ON canon_receipts WHEN NEW.page_path='' BEGIN SELECT RAISE(FAIL,'synthetic interruption'); END",
  );
  const options = {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  };
  await expect(
    resumeSourceRevocation(db, dir, "interrupt-canon", options),
  ).rejects.toThrow("synthetic interruption");
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(dir, receipt.page_path))).toBe(false);
  expect(inspectSourceGrant(db, a)?.status).toBe("denied");
  db.close();
  const reopened = openLedger(join(dir, ".kizuki", "kizuki.db"));
  reopened.exec("DROP TRIGGER interrupt_source_metadata");
  const done = await resumeSourceRevocation(
    reopened,
    dir,
    "interrupt-canon",
    options,
  );
  expect(done.status).toBe("purged");
  expect(done.erasure?.affected_receipt_ids).toContain(receipt.receipt_id);
  expect(existsSync(join(dir, receipt.page_path))).toBe(false);
  reopened.close();
});

test("mixed erasure removes A-only page-index subject while B without a subject remains searchable and restorable", async () => {
  const { db, dir, a, b } = setup();
  grant(db, a);
  setSourceGrant(db, {
    source_key: b,
    expected_revision: 0,
    operation_id: "subject-b",
    policy: policy(),
  });
  const subject = "person:qzxsensitivesubject5817";
  const aa = accept(
    db,
    { ...event(), text: subject, source_record_id: "subject-a" },
    { source: { source_key: a, expected_revision: 1 } },
  );
  const bb = accept(
    db,
    {
      ...event(),
      text: "Independent B survivorship",
      source_record_id: "subject-b",
    },
    { source: { source_key: b, expected_revision: 1 } },
  );
  if (aa.status !== "stored" || bb.status !== "stored")
    throw new Error("fixture failed");
  const io = { db, vault_path: dir };
  const original = write(
    io,
    await storeClaim(db, aa.event.event_id, {
      target: "people/shared-source-page",
      subject,
      subjects: [subject],
      body: "A-only source paragraph.",
      frontmatter: { type: "person", title: "A-only subject" },
    }),
  );
  const filed = await insertClaim(
    { db },
    {
      kind: "merge",
      target: original.page_path.replace(/\.md$/, ""),
      body: "Independent B survivorship",
      subjects: [],
      frontmatter: { type: "person", title: "Independent B" },
      provenance: [bb.event.event_id],
      producer: "deterministic",
      confidence: 0.8,
      sensitivity: "private",
      taint: "clean",
    },
  );
  if (!("claim" in filed)) throw new Error("fixture claim failed");
  write(io, filed.claim);
  expect(
    db
      .query("SELECT subject_key FROM page_index WHERE rel_path=?")
      .get(original.page_path),
  ).toEqual({ subject_key: subject });
  await rebuildRetrieval(db, dir);
  revokeSourceGrant(db, {
    source_key: a,
    expected_revision: 1,
    operation_id: "subject-revoke",
  });
  const options = {
    ownedRetrieval: {
      stores: async () => ({ stores: [], absent_store_ids: [] }),
    },
  };
  const done = await resumeSourceRevocation(db, dir, "subject-revoke", options);
  expect(done.status).toBe("purged");
  expect(
    db
      .query("SELECT subject_key FROM page_index WHERE rel_path=?")
      .get(original.page_path),
  ).toEqual({ subject_key: null });
  const { serveSearch } = await import("../src/index");
  const owner = { db, vaultPath: dir, principal: OWNER };
  expect(
    (await serveSearch(owner, { query: "qzxsensitivesubject5817" })).canon,
  ).toEqual([]);
  expect(
    (await serveSearch(owner, { query: "survivorship" })).canon,
  ).toHaveLength(1);
  const packet = await serveContextPacket(owner, {
    query: "survivorship",
    budget_tokens: 2000,
  });
  expect(packet.data?.packet_md).toContain("Independent B");
  expect(packet.data?.packet_md).not.toContain(subject);
  const roundtrip = mkdtempSync(join(tmpdir(), "subject-erasure-roundtrip-"));
  dirs.push(roundtrip);
  exportVault(db, dir, join(roundtrip, "backup"));
  restoreVault(join(roundtrip, "backup"), join(roundtrip, "restored"));
  const restored = openLedger(
    join(roundtrip, "restored", ".kizuki", "kizuki.db"),
  );
  expect(
    restored
      .query("SELECT subject_key FROM page_index WHERE rel_path=?")
      .get(original.page_path),
  ).toEqual({ subject_key: null });
  restored.close();
  db.close();
});
