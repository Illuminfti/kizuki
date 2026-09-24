import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { LLM_CONTRACT, type LlmPort } from "../../src/contracts/llm";
import { PortError } from "../../src/contracts/ports";
import {
  EXTRACT_RESPONSE_V2_SCHEMA,
  PRODUCER_V2_CONTRACT,
  type ProduceInputV2,
  type ProducerV2Port,
} from "../../src/contracts/producer-v2";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import {
  bindSourceModelPort,
  setSourceGrant,
} from "../../src/ledger/source-grants";
import { createModelProducerV2Port } from "../../src/producer/model-v2";
import { readExtractCursor } from "../../src/serve/extract";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";

/** Synthetic throughput fixtures: numbered neutral records under one extraction grant. */
export const ENDPOINT = "https://models.example.test/v1/chat/completions";
export const MODEL = "fixture-throughput-model";
const LABEL_CHARS = 7;

export const recordText = (index: number): string =>
  `Item${String(index).padStart(3, "0")} is a synthetic record.`;

export interface ThroughputVault {
  readonly root: string;
  readonly vault: string;
  readonly ledger: string;
  readonly eventIds: readonly string[];
  dispose(): void;
}

export function throughputVault(records: number): ThroughputVault {
  const root = mkdtempSync(join(tmpdir(), "kizuki-throughput-"));
  const vault = join(root, "vault");
  initVault(vault);
  const ledger = join(vault, ".kizuki", "kizuki.db");
  const db = openLedger(ledger);
  try {
    const sourceKey = "01J00000000000000000000SRC";
    registerConnection(db, "kizuki.fixture", sourceKey);
    setSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 0,
      operation_id: "throughput-fixture-grant",
      policy: {
        purposes: ["capture", "recall", "derive", "extract"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: {
          model_endpoint: ENDPOINT,
          model: MODEL,
          external_retention: "provider_managed",
        },
        sensitivity_floor: "public",
      },
    });
    const eventIds = db.transaction(() =>
      Array.from({ length: records }, (_, index) => {
        const accepted = accept(
          db,
          {
            ...validEvent(),
            connector_id: "kizuki.fixture",
            source_record_id: `throughput-${index}`,
            text: recordText(index),
            subjects: [],
          },
          { source: { source_key: sourceKey, expected_revision: 1 } },
        );
        if (accepted.status !== "stored")
          throw new Error("fixture capture failed");
        return accepted.event.event_id;
      }),
    )();
    return {
      root,
      vault,
      ledger,
      eventIds,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } finally {
    db.close();
  }
}

export function writeServeToml(vault: string, body: string): void {
  writeFileSync(join(vault, ".kizuki", "serve.toml"), body, { mode: 0o600 });
}

/** One anchored concept claim per record: the smallest valid typed response. */
export function typedResponse(
  events: readonly { event_id: string; text: string }[],
) {
  return {
    schema: EXTRACT_RESPONSE_V2_SCHEMA,
    mentions: events.map((event, index) => ({
      id: `m${index}`,
      label: event.text.slice(0, LABEL_CHARS),
      anchor: {
        event_id: event.event_id,
        start_utf16: 0,
        end_utf16: LABEL_CHARS,
      },
      candidate_refs: [],
    })),
    claims: events.map((event, index) => ({
      id: `c${index}`,
      subject: { kind: "mention" as const, id: `m${index}` },
      predicate: "concept.definition",
      object: {
        kind: "literal" as const,
        value: `A synthetic definition of ${event.text.slice(0, LABEL_CHARS)}.`,
      },
      perspective: {
        holder: null,
        speaker: null,
        addressee: null,
        mode: "asserted" as const,
        interpretation: "explicit" as const,
        anchors: [],
      },
      context: [],
      polarity: "positive" as const,
      body: `${event.text.slice(0, LABEL_CHARS)} has a synthetic definition.`,
      valid_from: null,
      valid_to: null,
      temporal_basis: "unknown" as const,
      confidence: 0.8,
      sensitivity: "public" as const,
      anchors: [
        { event_id: event.event_id, start_utf16: 0, end_utf16: LABEL_CHARS },
      ],
    })),
  };
}

export interface ObservedCall {
  readonly event_ids: readonly string[];
  readonly budget: ProduceInputV2["budget"];
  /** The durable extraction checkpoint when the request left. */
  readonly cursor: string | null;
}

/** A typed producer bound to the fixture grant that records every request. */
export function fixtureProducer(
  db: () => Database,
  onCall: (call: ObservedCall, index: number) => void | Promise<void> = () =>
    undefined,
): { producer: ProducerV2Port; calls: ObservedCall[] } {
  const calls: ObservedCall[] = [];
  const producer = bindSourceModelPort<ProducerV2Port>(
    {
      descriptor: {
        id: "kizuki.producer.fixture-throughput",
        kind: "producer",
        contract: PRODUCER_V2_CONTRACT,
        contract_minor: 0,
        supports: ["model"],
        requires_lease: false,
        optional_package: null,
      },
      model_ref: MODEL,
      health: async () => ({ status: "ready", detail: {} }),
      close: async () => undefined,
      async produce(input: ProduceInputV2) {
        const call = {
          event_ids: input.events.map((event) => event.event_id),
          budget: input.budget,
          cursor: readExtractCursor(db()),
        };
        calls.push(call);
        await onCall(call, calls.length);
        return {
          status: "ok",
          response: typedResponse(input.events),
          usage: { calls: 1, input_tokens: 10, output_tokens: 20 },
        };
      },
    },
    { model_endpoint: ENDPOINT, model: MODEL },
  );
  return { producer, calls };
}

/**
 * The shipped typed producer over a scripted chat port. `reply` returns
 * "rate_limited" for a request the provider still refuses after the port's
 * own bounded retries, exactly as the OpenAI-compatible port reports it.
 */
export function scriptedModelProducer(
  vault: string,
  reply: (request: number) => "ok" | "rate_limited",
): { producer: ProducerV2Port; requests: string[][] } {
  const requests: string[][] = [];
  const llm: LlmPort = {
    descriptor: {
      id: "kizuki.llm.fixture-throughput",
      kind: "llm",
      contract: LLM_CONTRACT,
      contract_minor: 0,
      supports: ["chat"],
      requires_lease: false,
      optional_package: null,
    },
    model_ref: MODEL,
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    async complete(request) {
      const prompt = request.messages
        .map((message) => message.content)
        .join("\n");
      const ids = [...prompt.matchAll(/event:([0-9A-HJKMNP-TV-Z]{26})/g)].map(
        (match) => match[1]!,
      );
      requests.push(ids);
      if (reply(requests.length) === "rate_limited")
        throw new PortError("unavailable", "http 429", true);
      const texts = new Map(
        ids.map((id) => [
          id,
          prompt
            .slice(prompt.indexOf(`event:${id}`))
            .match(/Item\d{3} is a synthetic record\./)![0],
        ]),
      );
      return {
        text: JSON.stringify(
          typedResponse(
            ids.map((event_id) => ({ event_id, text: texts.get(event_id)! })),
          ),
        ),
        model: MODEL,
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    },
  };
  const producer = createModelProducerV2Port(
    {
      vault_path: vault,
      data_dir: join(vault, ".kizuki"),
      config: {},
      secrets: async () => {
        throw new Error("no secrets in fixtures");
      },
      clock: () => new Date().toISOString(),
      logger: () => undefined,
    },
    { llm },
  );
  return {
    producer: bindSourceModelPort(producer, {
      model_endpoint: ENDPOINT,
      model: MODEL,
    }),
    requests,
  };
}
