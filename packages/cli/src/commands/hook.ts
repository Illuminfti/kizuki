import { UsageError, parseArguments } from "../args";
import { HARNESSES, runSessionStart } from "../hook/session-start";
import type { Harness, SessionStartOptions } from "../hook/session-start";
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

/** A number outside its range is pulled to the nearest bound and an unreadable one falls back: a settings typo must not fail every session. */
function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export const hookCommand: Command = {
  name: "hook",
  usage: USAGE,
  summary: "inject a bounded Kizuki context block at a harness session start",
  schema: HOOK_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    if (args[0] !== "session-start") throw new UsageError(USAGE);
    // A hook must never cost the session: a misconfigured command is as silent as a failed read.
    // `--verbose` still names the class of problem on standard error.
    const verbose = args.includes("--verbose");
    let options: SessionStartOptions;
    try {
      const parsed = parseArguments(args.slice(1), {
        options: [...HOOK_SCHEMA.options],
        flags: [...HOOK_SCHEMA.flags],
      });
      const harness = parsed.options.get("--harness");
      const tokenRef = parsed.options.get("--token-ref");
      if (
        parsed.positionals.length !== 0 ||
        harness === undefined ||
        !(HARNESSES as readonly string[]).includes(harness) ||
        (tokenRef !== undefined && !validTokenRef(tokenRef))
      )
        throw new UsageError(USAGE);
      options = {
        harness: harness as Harness,
        budget: bounded(parsed.options.get("--budget"), 450, 50, 2_000),
        timeoutMs: bounded(parsed.options.get("--timeout-ms"), 2_500, 100, 60_000),
        tokenRef,
        direct: parsed.flags.has("--direct"),
      };
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      if (verbose) io.err("hook: nothing injected (usage)");
      return 0;
    }

    const result = await runSessionStart(io, options);
    if ("output" in result) io.out(result.output);
    else if (verbose) io.err(`hook: nothing injected (${result.skip})`);
    return 0;
  },
};
