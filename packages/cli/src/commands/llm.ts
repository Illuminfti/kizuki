import {
  ChatClient,
  LLM_CONFIG_DEFAULTS,
  LlmError,
  endpointHost,
  parseLlmConfig,
  parseModelJson,
  readLlmConfig,
  removeLlmConfig,
  resolveApiKey,
  systemPrompt,
  validateSummary,
  wrapEvent,
  writeLlmConfig,
} from "@kizuki/llm";
import type { LlmConfig } from "@kizuki/llm";
import type { CaptureEvent } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { assertVault, resolveVault } from "../context";
import { configPath, readConfig } from "../config";
import { jsonLine } from "../output";
import type { CliIo, Command } from "./index";

const OPTIONS = [
  "--base-url",
  "--model",
  "--api-key",
  "--ceiling",
  "--unlabeled",
  "--temperature",
  "--timeout-ms",
  "--rpm",
  "--max-requests",
  "--max-input-chars",
  "--max-event-chars",
  "--max-output-tokens",
  "--summary-min-chars",
];

const FLAGS = [
  "--json",
  "--no-api-key",
  "--allow-cloud-inference",
  "--no-allow-cloud-inference",
  "--json-mode",
  "--no-json-mode",
];

/** What `llm test` sends: a synthetic record, never anything captured. */
const PROBE: CaptureEvent = {
  schema: "kizuki.event/v1",
  event_id: "00000000000000000000000000",
  connector_id: "kizuki.llm-test",
  source_record_id: "probe",
  kind: "probe",
  occurred_at: "2026-01-01T00:00:00Z",
  observed_at: "2026-01-01T00:00:00Z",
  text: "The kettle is on and ada is reading at the acme library.",
  subjects: [],
  deleted: false,
  attachments: [],
  metadata: {},
  content_hash: "0".repeat(64),
};

export function describeConfig(config: LlmConfig): string {
  return [
    `llm host=${endpointHost(config.base_url)}`,
    `model=${config.model}`,
    `api_key=${config.api_key_ref ?? "none"}`,
    `cloud=${config.allow_cloud_inference}`,
    `ceiling=${config.sensitivity_ceiling}`,
    `unlabeled=${config.unlabeled}`,
    `json_mode=${config.json_mode}`,
    `timeout_ms=${config.timeout_ms}`,
    `rpm=${config.requests_per_minute}`,
    `max_requests=${config.max_requests}`,
  ].join(" ");
}

export function reportLlmError(io: CliIo, error: LlmError): number {
  const status = error.status === null ? "" : ` status=${error.status}`;
  io.err(`error: llm ${error.code}${status}: ${error.message}`);
  return 1;
}

function numberOption(
  options: Map<string, string>,
  name: string,
): number | undefined {
  const raw = options.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${name} must be a number`);
  return value;
}

function pairedBoolean(
  flags: Set<string>,
  on: string,
  off: string,
): boolean | undefined {
  if (flags.has(on) && flags.has(off)) {
    throw new UsageError(`${on} and ${off} are contradictory`);
  }
  if (flags.has(on)) return true;
  if (flags.has(off)) return false;
  return undefined;
}

type Scalar = string | number | boolean;

const TAIL_KEYS = [
  "allow_cloud_inference",
  "sensitivity_ceiling",
  "unlabeled",
  "json_mode",
  "temperature",
  "timeout_ms",
  "requests_per_minute",
  "max_requests",
  "max_input_chars",
  "max_event_chars",
  "max_output_tokens",
  "summary_min_chars",
] as const;

/**
 * A partial update starts from the file when there is one, so an owner can
 * change a single knob without restating the endpoint. The overlay is
 * serialized and handed to `parseLlmConfig`, which stays the only validation
 * path: an invalid combination never reaches the disk.
 */
function nextConfig(
  existing: LlmConfig | null,
  options: Map<string, string>,
  flags: Set<string>,
): LlmConfig {
  const base: Record<string, Scalar | null> = {
    ...(existing ?? { ...LLM_CONFIG_DEFAULTS, base_url: "", model: "" }),
  };
  const apiKey = options.get("--api-key");
  if (apiKey !== undefined && flags.has("--no-api-key")) {
    throw new UsageError("--api-key and --no-api-key are contradictory");
  }
  const overlay: Record<string, Scalar | null | undefined> = {
    base_url: options.get("--base-url"),
    model: options.get("--model"),
    api_key_ref: flags.has("--no-api-key") ? null : apiKey,
    allow_cloud_inference: pairedBoolean(
      flags,
      "--allow-cloud-inference",
      "--no-allow-cloud-inference",
    ),
    sensitivity_ceiling: options.get("--ceiling"),
    unlabeled: options.get("--unlabeled"),
    json_mode: pairedBoolean(flags, "--json-mode", "--no-json-mode"),
    temperature: numberOption(options, "--temperature"),
    timeout_ms: numberOption(options, "--timeout-ms"),
    requests_per_minute: numberOption(options, "--rpm"),
    max_requests: numberOption(options, "--max-requests"),
    max_input_chars: numberOption(options, "--max-input-chars"),
    max_event_chars: numberOption(options, "--max-event-chars"),
    max_output_tokens: numberOption(options, "--max-output-tokens"),
    summary_min_chars: numberOption(options, "--summary-min-chars"),
  };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) base[key] = value;
  }

  const url = base["base_url"];
  const model = base["model"];
  if (typeof url !== "string" || url.length === 0) {
    throw new UsageError("--base-url is required for a new endpoint");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new UsageError("--model is required for a new endpoint");
  }

  const lines: string[] = [];
  const push = (key: string, value: Scalar): void => {
    lines.push(
      `${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
    );
  };
  push("base_url", url);
  push("model", model);
  const ref = base["api_key_ref"];
  if (typeof ref === "string") push("api_key", ref);
  for (const key of TAIL_KEYS) {
    const value = base[key];
    if (value !== null && value !== undefined) push(key, value);
  }
  return parseLlmConfig(`${lines.join("\n")}\n`);
}

async function probe(io: CliIo, config: LlmConfig): Promise<number> {
  const apiKey =
    config.api_key_ref === null
      ? null
      : resolveApiKey(config.api_key_ref, io.env);
  const client = new ChatClient({ config, api_key: apiKey });
  const wrapped = wrapEvent(PROBE, "summary", config.max_event_chars);
  const outcome = await client.complete(systemPrompt("summary"), wrapped.user);
  if (!outcome.ok) return reportLlmError(io, outcome.error);
  const parsed = parseModelJson(outcome.content);
  if (parsed === undefined || !validateSummary(parsed).ok) {
    return reportLlmError(
      io,
      new LlmError(
        "bad_response",
        "the endpoint answered, but not with the requested JSON object",
      ),
    );
  }
  io.out(
    `ok host=${endpointHost(config.base_url)} model=${outcome.model ?? config.model} latency_ms=${outcome.latency_ms} json_mode=${config.json_mode}`,
  );
  return 0;
}

/** The vault path alone: none of the subverbs needs the database open. */
function vaultOf(io: CliIo): string {
  const config = readConfig(configPath(io.env));
  return assertVault(resolveVault(io.env, config, io.vaultOverride));
}

export const llmCommand: Command = {
  name: "llm",
  usage: "llm <set|show|test|unset> [options]",
  summary: "configure and check the optional model endpoint",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: OPTIONS, flags: FLAGS });
    const [subverb] = requirePositional(parsed.positionals, 1);
    if (subverb === undefined) throw new UsageError(this.usage);
    const vaultPath = vaultOf(io);

    try {
      if (subverb === "set") {
        const config = nextConfig(
          readLlmConfig(vaultPath),
          parsed.options,
          parsed.flags,
        );
        writeLlmConfig(vaultPath, config);
        io.out(describeConfig(config));
        return 0;
      }
      if (subverb === "show") {
        const config = readLlmConfig(vaultPath);
        if (parsed.flags.has("--json")) {
          io.out(jsonLine(config));
          return 0;
        }
        io.out(config === null ? "llm unconfigured" : describeConfig(config));
        return 0;
      }
      if (subverb === "test") {
        const config = readLlmConfig(vaultPath);
        if (config === null) {
          return reportLlmError(
            io,
            new LlmError(
              "unconfigured",
              "no model endpoint configured; run: kizuki llm set --base-url URL --model NAME",
            ),
          );
        }
        return await probe(io, config);
      }
      if (subverb === "unset") {
        removeLlmConfig(vaultPath);
        io.out("llm unconfigured");
        return 0;
      }
    } catch (error) {
      if (error instanceof LlmError) return reportLlmError(io, error);
      throw error;
    }
    throw new UsageError(this.usage);
  },
};
