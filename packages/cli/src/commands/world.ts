import {
  OWNER,
  WorldViewError,
  isWorldWireToken,
  serveWorldView,
} from "@kizuki/core";
import type { WorldReadResult } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { clean, jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const OPERATIONS = [
  "situation",
  "concept",
  "find_concepts",
  "find_situations",
] as const;
export const WORLD_SCHEMA = {
  options: ["--operation", "--ref", "--label"],
  flags: ["--json"],
  bounds: {
    "--operation": "situation|concept|find_concepts|find_situations",
    "--ref": "32-byte base64url object token",
    "--label": "up to 200 characters",
  },
} as const satisfies CommandHelpSchema;

const SITUATION_LABELS: Readonly<Record<string, string>> = {
  "situation.objective": "Objective",
  "situation.blocker": "Blocker",
  "situation.change": "Recent change",
  "situation.commitment": "Commitment",
};

function render(result: WorldReadResult): string[] {
  if ("status" in result) return ["not found"];
  if (result.result.status === "unavailable")
    return [`World view unavailable: ${result.result.reason}.`];
  const data = result.result.data;
  if ("matches" in data) {
    return data.matches.length === 0
      ? ["No admitted matches in your current scope."]
      : data.matches.map(
          (match) =>
            `${clean(match.labels.join(" / ")) || "Unlabelled"}  ${match.ref.token}`,
        );
  }
  if (data.schema === "kizuki.concept-card/v1")
    return [
      clean(data.concept.labels.map((label) => label.text).join(" / ")) ||
        "Concept",
      ...data.definitions.map((definition) =>
        definition.object.kind === "literal"
          ? clean(definition.object.value)
          : "Qualified linked definition",
      ),
      `Coverage: ${data.coverage.status}; history: ${data.coverage.history}.`,
    ];
  return [
    clean(data.situation.labels.map((label) => label.text).join(" / ")) ||
      "Situation",
    ...[
      data.objective,
      data.blocker,
      data.recentChange,
      ...data.commitments,
    ].flatMap((item) =>
      item?.object.kind === "literal"
        ? [`${SITUATION_LABELS[item.predicate] ?? item.predicate}: ${clean(item.object.value)}`]
        : [],
    ),
    `Coverage: ${data.coverage.status}; history: ${data.coverage.history}.`,
  ];
}

export const worldCommand: Command = {
  name: "world",
  usage:
    "world --operation concept|situation --ref TOKEN [--json] | world --operation find_concepts|find_situations [--label TEXT] [--json]",
  summary:
    "discover and read admitted Concepts and Situations in your current scope",
  schema: WORLD_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...WORLD_SCHEMA.options],
      flags: [...WORLD_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const operation = parsed.options.get("--operation"),
      ref = parsed.options.get("--ref"),
      label = parsed.options.get("--label");
    if (
      operation === undefined ||
      !(OPERATIONS as readonly string[]).includes(operation)
    )
      throw new UsageError(this.usage);
    const discovery =
      operation === "find_concepts" || operation === "find_situations";
    if (
      discovery
        ? ref !== undefined || (label?.length ?? 0) > 200
        : label !== undefined || ref === undefined || !isWorldWireToken(ref)
    )
      throw new UsageError(this.usage);
    const input = {
      operation,
      ...(discovery
        ? { label: label ?? "" }
        : { [operation]: { kind: "object", token: ref } }),
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    };
    // Reference issuance is durable bookkeeping and needs the normal bound ledger writer.
    return withVault(
      io,
      async (ctx) => {
        try {
          const envelope = serveWorldView(
            { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER },
            input,
          );
          if (parsed.flags.has("--json"))
            io.out(jsonEnvelope("world", "ok", envelope));
          else for (const line of render(envelope.data)) io.out(line);
          const data = envelope.data;
          if (!("status" in data) && data.result.status !== "unavailable" && "matches" in data.result.data && data.result.data.matches.length === 0)
            io.err("next: Concepts and Situations appear once the model loop admits them; kizuki doctor shows whether canon writing is on");
        } catch (error) {
          if (error instanceof WorldViewError) throw new UsageError(this.usage);
          throw error;
        }
        return 0;
      },
      { retrieval: "none" },
    );
  },
};
