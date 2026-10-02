import { ENVELOPE_SCHEMA, ServeError, dispatchServeTool } from "@kizuki/core";
import type { ServeContext, Tool } from "@kizuki/core";
import { ENVELOPE_V2_SCHEMA, unsupportedContract } from "@kizuki/core/world";
import type { EnvelopeV2 } from "@kizuki/core/world";
import type { CliIo } from "./commands/index";

export const RESPONSE_CONTRACT_OPTION = "--response-contract";
export const RESPONSE_CONTRACT_BOUND = `${ENVELOPE_SCHEMA}|${ENVELOPE_V2_SCHEMA}`;

/**
 * The contract the owner asked for by name, unless it is the v1 form every
 * command already speaks. Core judges the value, so an unknown one is refused
 * there with the same audited answer as on every other transport.
 */
export function responseContract(options: ReadonlyMap<string, string>): string | undefined {
  const requested = options.get(RESPONSE_CONTRACT_OPTION);
  return requested === ENVELOPE_SCHEMA ? undefined : requested;
}

/** One call served under the named contract, and nothing but the closed envelope back. */
export async function serveV2(
  serve: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  contract: string,
): Promise<EnvelopeV2> {
  const envelope = await dispatchServeTool(serve, tool, args, { response_contract: contract });
  if (envelope.schema !== ENVELOPE_V2_SCHEMA) throw unsupportedContract();
  return envelope;
}

/** `--json` under v2 is this one closed wrapper, not the v1 command envelope. */
export function cliResultV2(command: "query" | "context" | "tell", result: EnvelopeV2): string {
  return JSON.stringify({ schema: "kizuki.cli-result/v2", command, result });
}

/** The contract refusal is identical on every CLI consumer, including machine output. */
export function contractFailure(io: CliIo, command: "query" | "context" | "tell", json: boolean, error: unknown): number {
  if (!(error instanceof ServeError) || error.code !== "unsupported_contract") throw error;
  if (json) io.out(JSON.stringify({ schema: "kizuki.cli-result/v2", command,
    result: { ok: false, error: { code: error.code, message: error.message, retryable: false } },
  }));
  io.err(`error: ${error.message}`);
  return 1;
}
