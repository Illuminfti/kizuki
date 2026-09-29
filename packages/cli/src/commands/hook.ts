import { UsageError, parseArguments } from "../args";
import { HARNESSES, runSessionStart } from "../hook/session-start";
import type { Harness } from "../hook/session-start";
import { validTokenRef } from "../secrets";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const HOOK_SCHEMA = {
  options: ["--harness", "--budget", "--timeout-ms", "--token-ref"],
  flags: ["--direct", "--verbose"],
  defaults: { "--budget": "450", "--timeout-ms": "2500" },
  bounds: {
    "--harness": "claude-code|codex|generic",
    "--budget": "50..2000",
    "--timeout-ms": "100..60000",
    "--token-ref": "env:VAR|file:/absolute/path",
  },
} as const satisfies CommandHelpSchema;

const USAGE =
  "hook session-start --harness claude-code|codex|generic [--budget N] [--timeout-ms MS] [--token-ref env:VAR|file:/absolute/path] [--direct] [--verbose]";

function bounded(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new UsageError(`invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new UsageError(`invalid ${name}`);
  return value;
}

export const hookCommand: Command = {
  name: "hook",
  usage: USAGE,
  summary: "inject a bounded Kizuki context block at a harness session start",
  schema: HOOK_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    if (args[0] !== "session-start") throw new UsageError(USAGE);
    const parsed = parseArguments(args.slice(1), {
      options: [...HOOK_SCHEMA.options],
      flags: [...HOOK_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(USAGE);
    const harness = parsed.options.get("--harness");
    if (
      harness === undefined ||
      !(HARNESSES as readonly string[]).includes(harness)
    ) {
      throw new UsageError("invalid --harness");
    }
    const tokenRef = parsed.options.get("--token-ref");
    if (tokenRef !== undefined && !validTokenRef(tokenRef))
      throw new UsageError("invalid --token-ref");
    const options = {
      harness: harness as Harness,
      budget: bounded(
        parsed.options.get("--budget"),
        450,
        50,
        2_000,
        "--budget",
      ),
      timeoutMs: bounded(
        parsed.options.get("--timeout-ms"),
        2_500,
        100,
        60_000,
        "--timeout-ms",
      ),
      tokenRef,
      direct: parsed.flags.has("--direct"),
    };

    // A hook must never cost the session: everything past argument checks fails closed to silence.
    const result = await runSessionStart(io, options);
    if ("output" in result) io.out(result.output);
    else if (parsed.flags.has("--verbose"))
      io.err(`hook: nothing injected (${result.skip})`);
    return 0;
  },
};
