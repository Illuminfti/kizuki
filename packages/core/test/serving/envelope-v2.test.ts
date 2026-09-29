/**
 * Envelope v2 and context-packet v2 at the loopback HTTP seam.
 *
 * A scoped reader that asks for `kizuki.envelope/v2` must learn nothing about
 * policy state outside its grant: no epoch, no source-policy counter and no
 * denied count anywhere in the answer, and a hidden source revoke changes no
 * byte of it except the request time.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, listAudit } from "../../src/agents";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { hiddenScene } from "../helpers/noninterference";
import type { NoninterferenceScene } from "../helpers/noninterference";
import { startLoopback } from "../helpers/world-kit/loopback";
import type { Loopback } from "../helpers/world-kit/loopback";

// Each scenario builds a real ledger, so bound the tests for a loaded host.
setDefaultTimeout(120_000);

const V1 = "kizuki.envelope/v1";
const V2 = "kizuki.envelope/v2";
const FORBIDDEN_KEYS = new Set([
  "epoch",
  "claims_epoch",
  "source_policy",
  "denied",
]);
const ENVELOPE_V2_KEYS = [
  "at",
  "canon",
  "data",
  "principal",
  "quoted",
  "schema",
  "tool",
];

interface Reply {
  readonly status: number;
  readonly body: Record<string, any>;
}

interface Rig {
  readonly scene: NoninterferenceScene;
  readonly loopback: Loopback;
  readonly agentName: string;
  readonly agentToken: string;
  /** POST as the narrow agent. */
  agent(tool: string, body: Record<string, unknown>): Promise<Reply>;
  /** POST as the owner. */
  owner(tool: string, body: Record<string, unknown>): Promise<Reply>;
  revokeHiddenSource(): void;
  dispose(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const scene = await hiddenScene();
  const loopback = await startLoopback(scene.db, scene.vaultPath);
  const agentName = "envelope-b";
  const { token } = addAgent(scene.db, agentName, {
    ...OWNER_AGENT_GRANT,
    ceiling: "public",
    subjects: ["topic:bayes", "project:launch"],
  });
  return {
    scene,
    loopback,
    agentName,
    agentToken: token,
    agent: (tool, body) => loopback.post(tool, body, token) as Promise<Reply>,
    owner: (tool, body) => loopback.post(tool, body) as Promise<Reply>,
    revokeHiddenSource() {
      revokeSourceGrant(scene.db, {
        source_key: scene.hidden.sourceKey,
        expected_revision: 1,
        operation_id: "envelope-v2-revoke",
      });
    },
    async dispose() {
      await loopback.stop();
      scene.dispose();
    },
  };
}

const v2 = (args: Record<string, unknown>) => ({ response_contract: V2, args });

/** Every path at which a key the scoped contract must not carry appears. */
function forbiddenPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      forbiddenPaths(item, `${path}[${index}]`),
    );
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => [
      ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
      ...forbiddenPaths(item, `${path}.${key}`),
    ],
  );
}

/** The request instant and the validity horizon derived from it are the only bytes allowed to move. */
function withoutTime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTime);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "at" || key === "validUntil" ? "<time>" : withoutTime(item),
    ]),
  );
}

const PACKET = { query: "Bayesian", budget_tokens: 1_000 };

test("a hidden source revoke leaves the scoped v2 packet byte-equal, epoch-free and still unchanged", async () => {
  const r = await rig();
  try {
    const before = await r.agent("context_packet", v2(PACKET));
    expect(before.status).toBe(200);
    const envelope = before.body.value;
    expect(envelope.schema).toBe(V2);
    expect(Object.keys(envelope).sort()).toEqual(ENVELOPE_V2_KEYS);
    expect(envelope.data.schema).toBe("kizuki.context-packet/v2");
    expect(forbiddenPaths(before.body)).toEqual([]);
    const current = envelope.data.result;
    expect(current.status).toBe("current");
    expect(current.data.packetMd).toStartWith("KIZUKI CONTEXT v2\n");
    expect(current.data.packetMd).not.toMatch(/epoch|etag|packet_hash/);
    expect(Object.keys(current.data)).not.toContain("claimsEpoch");

    r.revokeHiddenSource();

    const after = await r.agent("context_packet", v2(PACKET));
    expect(after.status).toBe(200);
    expect(withoutTime(after.body)).toEqual(withoutTime(before.body));

    const again = await r.agent(
      "context_packet",
      v2({ ...PACKET, priorView: current.view }),
    );
    expect(again.body.value.data.result).toMatchObject({
      status: "unchanged",
      view: current.view,
    });
    expect(again.body.value.data.result.data).toBeUndefined();
    expect(forbiddenPaths(again.body)).toEqual([]);
  } finally {
    await r.dispose();
  }
});

test("the same revoke moves the epoch a v1 caller can read, which is the leak the v2 contract closes", async () => {
  const r = await rig();
  try {
    const before = await r.agent("context_packet", PACKET);
    expect(before.body.value.schema).toBe(V1);
    r.revokeHiddenSource();
    const after = await r.agent("context_packet", PACKET);
    expect(after.body.value.data.claims_epoch).toBeGreaterThan(
      before.body.value.data.claims_epoch,
    );
  } finally {
    await r.dispose();
  }
});

test("the selector table: owner keeps v1, explicit v2 gets v2, anything else is one fixed refusal", async () => {
  const r = await rig();
  try {
    const bare = await r.owner("search", { query: "Bayesian" });
    expect(bare.body.value.schema).toBe(V1);
    const explicitV1 = await r.owner("search", {
      response_contract: V1,
      args: { query: "Bayesian" },
    });
    expect(explicitV1.body.value.schema).toBe(V1);
    const explicitV2 = await r.owner("search", v2({ query: "Bayesian" }));
    expect(explicitV2.body.value.schema).toBe(V2);
    expect(Object.keys(explicitV2.body.value).sort()).toEqual(ENVELOPE_V2_KEYS);

    const fixed = {
      ok: false,
      error: {
        code: "unsupported_contract",
        message: "requested contract unavailable",
        retryable: false,
      },
    };
    const refusals: Record<string, Record<string, unknown>> = {
      unknown: {
        response_contract: "kizuki.envelope/v3",
        args: { query: "Bayesian" },
      },
      "not a string": { response_contract: 2, args: { query: "Bayesian" } },
      nested: { args: { response_contract: V2, query: "Bayesian" } },
      conflicting: {
        response_contract: V2,
        args: { response_contract: V1, query: "Bayesian" },
      },
      "flat beside the arguments": { response_contract: V2, query: "Bayesian" },
      "wrapper with another key": {
        response_contract: V2,
        args: { query: "Bayesian" },
        extra: true,
      },
    };
    for (const [name, body] of Object.entries(refusals)) {
      for (const send of [r.owner, r.agent]) {
        const reply = await send("search", body);
        expect({ name, status: reply.status, body: reply.body }).toEqual({
          name,
          status: 400,
          body: fixed,
        });
      }
    }
  } finally {
    await r.dispose();
  }
});

test("a refused selector is audited and reads nothing", async () => {
  const r = await rig();
  try {
    await r.agent("search", {
      response_contract: "kizuki.envelope/v3",
      args: { query: "Bayesian" },
    });
    const rows = listAudit(r.scene.db, r.agentName, { limit: 5 }).filter(
      (row) => row.tool === "search",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.served).toEqual([]);
    expect(rows[0]!.denied).toEqual([
      { id: "tool:search", reason: "unsupported_contract" },
    ]);
  } finally {
    await r.dispose();
  }
});

test("system_health has no v2 form and world_view has no v1 form", async () => {
  const r = await rig();
  try {
    const fixed = {
      code: "unsupported_contract",
      message: "requested contract unavailable",
      retryable: false,
    };
    for (const send of [r.owner, r.agent]) {
      expect((await send("system_health", v2({}))).body.error).toEqual(fixed);
      expect(
        (
          await send("world_view", {
            response_contract: V1,
            args: { operation: "describe" },
          })
        ).body.error,
      ).toEqual(fixed);
      const described = await send("world_view", v2({ operation: "describe" }));
      expect(described.body.value.schema).toBe(V2);
    }
    // An owner that sends no selector to world_view still gets the v2 envelope it always got.
    expect(
      (await r.owner("world_view", { operation: "describe" })).body.value
        .schema,
    ).toBe(V2);
  } finally {
    await r.dispose();
  }
});
