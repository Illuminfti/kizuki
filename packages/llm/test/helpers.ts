import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LLM_CONTRACT,
  PortError,
  predicateIds,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  LlmPort,
  LlmRequest,
  LlmResponse,
  PortContext,
  PortDescriptor,
  PortHealth,
  PortLogLine,
  ProduceInput,
  ProduceResult,
  QuotedEvent,
} from "@kizuki/core";
import { OPENAI_COMPATIBLE_LLM, OpenAiCompatibleLlm } from "../src/llm-port";
import type { LlmPortOverrides } from "../src/llm-port";
import { MODEL_PRODUCER, ModelProducer } from "../src/producer";

export interface TestContext {
  ctx: PortContext;
  logs: PortLogLine[];
  cleanup(): void;
}

export function portContext(
  descriptor: PortDescriptor,
  config: Record<string, unknown> = {},
  secrets: (ref: string) => Promise<string> = async () => {
    throw new PortError("unavailable", "no secret is configured", false);
  },
): TestContext {
  const root = mkdtempSync(join(tmpdir(), "kizuki-llm-"));
  const vaultPath = join(root, "vault");
  const dataDir = join(vaultPath, ".kizuki", descriptor.kind, descriptor.id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logs: PortLogLine[] = [];
  return {
    logs,
    ctx: {
      vault_path: vaultPath,
      data_dir: dataDir,
      config: Object.freeze({ ...config }),
      secrets,
      clock: () => "2026-01-01T00:00:00.000Z",
      logger: (line) => logs.push(line),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function llmPort(
  config: Record<string, unknown>,
  overrides: LlmPortOverrides = {},
  secrets?: (ref: string) => Promise<string>,
): { port: OpenAiCompatibleLlm; cleanup(): void } {
  const built =
    secrets === undefined
      ? portContext(OPENAI_COMPATIBLE_LLM, config)
      : portContext(OPENAI_COMPATIBLE_LLM, config, secrets);
  return {
    port: new OpenAiCompatibleLlm(built.ctx, overrides),
    cleanup: built.cleanup,
  };
}

export function event(
  id: string,
  text: string,
  taint: "untrusted" | "owner" = "untrusted",
): QuotedEvent {
  return {
    event_id: id,
    connector_id: "markdown-folder",
    occurred_at: "2026-01-01T00:00:00.000Z",
    observed_at: "2026-01-01T00:00:01.000Z",
    text,
    subjects: [{ subject_id: "person:ada", role: "about" }],
    taint,
  };
}

export function produceInput(
  events: QuotedEvent[],
  budget: Partial<ProduceInput["budget"]> = {},
): ProduceInput {
  return {
    events,
    context: {
      subjects: [{ subject_id: "person:ada", role: "about" }],
      known_claims: [],
      predicates: predicateIds(),
    },
    budget: {
      max_calls: 8,
      max_input_tokens: 100_000,
      max_output_tokens: 100_000,
      ...budget,
    },
  };
}

export function claimsPayload(
  overrides: Record<string, unknown> = {},
  eventIds: string[] = ["ev-1"],
): string {
  return JSON.stringify({
    claims: [
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "Ada works at acme.",
        valid_from: null,
        valid_to: null,
        confidence: 0.6,
        sensitivity: "personal",
        event_ids: eventIds,
        ...overrides,
      },
    ],
  });
}

export interface ScriptedLlm extends LlmPort {
  readonly calls: LlmRequest[];
}

/**
 * An in-process `kizuki.llm/v1` so producer tests never need a socket. The
 * script is a list of answers or errors, replayed in order.
 */
export function scriptedLlm(
  script: (string | Error)[],
  health: PortHealth = { status: "ready", detail: {} },
  usage: { input_tokens: number; output_tokens: number; attempts: number } = {
    input_tokens: 10,
    output_tokens: 5,
    attempts: 1,
  },
): ScriptedLlm {
  const calls: LlmRequest[] = [];
  let index = 0;
  return {
    descriptor: OPENAI_COMPATIBLE_LLM,
    model_ref: "kizuki.llm.fake:m@127.0.0.1",
    calls,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next === undefined) {
        throw new PortError("unavailable", "the script is exhausted", false);
      }
      if (next instanceof Error) throw next;
      return {
        text: next,
        model: "m",
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
        attempts: usage.attempts,
      };
    },
    async health(): Promise<PortHealth> {
      return health;
    },
    async close(): Promise<void> {},
  };
}

/**
 * A model port that answers with whatever a host's implementation might. The
 * producer is handed whichever `kizuki.llm/v1` a vault bound, so a reply that
 * does not match the contract has to be refused at that boundary rather than
 * trusted; the assertion is the point of the double.
 */
export function answeringLlm(answer: unknown): ScriptedLlm {
  const calls: LlmRequest[] = [];
  return {
    descriptor: OPENAI_COMPATIBLE_LLM,
    model_ref: "kizuki.llm.fake:m@127.0.0.1",
    calls,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      return answer as LlmResponse;
    },
    async health(): Promise<PortHealth> {
      return { status: "ready", detail: {} };
    },
    async close(): Promise<void> {},
  };
}

/**
 * A model port whose answer depends on the request, so a test can stand in for
 * an endpoint that honours what it was granted rather than one that always
 * answers the same thing.
 */
export function replyingLlm(
  reply: (request: LlmRequest) => string,
): ScriptedLlm {
  const calls: LlmRequest[] = [];
  return {
    descriptor: OPENAI_COMPATIBLE_LLM,
    model_ref: "kizuki.llm.fake:m@127.0.0.1",
    calls,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      return {
        text: reply(request),
        model: "m",
        usage: { input_tokens: 10, output_tokens: 5 },
        attempts: 1,
      };
    },
    async health(): Promise<PortHealth> {
      return { status: "ready", detail: {} };
    },
    async close(): Promise<void> {},
  };
}

export interface ProducerHarness {
  port: ModelProducer;
  llm: ScriptedLlm;
  logs: PortLogLine[];
  cleanup(): void;
}

/** The producer over a scripted model port, so no producer test needs a socket. */
export function modelProducerFor(
  script: (string | Error)[],
  usage?: { input_tokens: number; output_tokens: number; attempts: number },
): ProducerHarness {
  const built = portContext(MODEL_PRODUCER);
  const llm =
    usage === undefined
      ? scriptedLlm(script)
      : scriptedLlm(script, { status: "ready", detail: {} }, usage);
  return {
    port: new ModelProducer(built.ctx, llm),
    llm,
    logs: built.logs,
    cleanup: built.cleanup,
  };
}

export function ok(
  result: ProduceResult,
): Extract<ProduceResult, { status: "ok" }> {
  if (result.status !== "ok") {
    throw new Error(`expected ok, got ${result.status}`);
  }
  return result;
}

/** A model port written to `kizuki.llm/v1` before `attempts` existed. */
export const MINOR_ZERO_LLM: PortDescriptor = validatePortDescriptor({
  id: "kizuki.llm.minor-zero",
  kind: "llm",
  contract: LLM_CONTRACT,
  contract_minor: 0,
  supports: ["chat"],
  requires_lease: false,
  optional_package: null,
});

/**
 * An implementation at minor 0: it answers, and it cannot say how many
 * requests the answer took, which is what the producer has to fall back from.
 */
export function minorZeroLlm(text: string): ScriptedLlm {
  const calls: LlmRequest[] = [];
  return {
    descriptor: MINOR_ZERO_LLM,
    model_ref: "kizuki.llm.minor-zero:m@127.0.0.1",
    calls,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      return {
        text,
        model: "m",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
    async health(): Promise<PortHealth> {
      return { status: "ready", detail: {} };
    },
    async close(): Promise<void> {},
  };
}
