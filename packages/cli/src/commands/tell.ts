import { CorrectError, OWNER, correct, isWorldWireToken, serveCorrect } from "@kizuki/core";
import type { CorrectArgs, WorldReadResult } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { tryRefreshDerived } from "../derived";
import { clean, jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const MODES = ["replace_object", "retract", "reclassify_mode"] as const;
const PERSPECTIVE_MODES = ["suggested", "hypothetical", "questioned"] as const;

export const TELL_SCHEMA = {
  options: [
    "--claim",
    "--world-claim",
    "--since",
    "--until",
    "--mode",
    "--object",
    "--object-ref",
    "--object-vocabulary",
    "--perspective-mode",
    "--refresh-concept-ref",
  ],
  flags: ["--dry-run", "--json", "--verbose"],
  bounds: {
    "--since": "TIME",
    "--until": "TIME",
    "--mode": MODES.join("|"),
    "--object": "up to 400 characters",
    "--object-ref": "32-byte base64url object token",
    "--object-vocabulary": "a registered vocabulary value",
    "--perspective-mode": PERSPECTIVE_MODES.join("|"),
    "--refresh-concept-ref": "32-byte base64url object token",
  },
} as const satisfies CommandHelpSchema;

/** The options only a world claim understands. */
const WORLD_ONLY = ["--mode", "--object", "--object-ref", "--object-vocabulary", "--perspective-mode", "--refresh-concept-ref"] as const;

function objectLine(relation: { predicate: string; polarity: string; object: { kind: string; value?: string; id?: string }; perspective: { mode: string } }): string {
  const object = relation.object;
  const value = object.kind === "literal" ? clean(object.value ?? "") : object.kind === "vocabulary" ? clean(object.id ?? "") : "a linked item";
  const held = relation.polarity === "negative" ? `not ${value}` : value;
  return `- ${clean(relation.predicate)}: ${relation.perspective.mode === "asserted" ? held : `${held} (${relation.perspective.mode})`}`;
}

/** The corrected concept, as it reads now: what each claim says and how it is held. */
function renderRefreshed(view: WorldReadResult): string[] {
  if ("status" in view) return ["Refreshed concept: not found."];
  if (view.result.status !== "current" && view.result.status !== "incomplete") return [];
  const data = view.result.data;
  if (!("concept" in data)) return [];
  const label = clean(data.concept.labels.map((entry) => entry.text).join(" / ")) || "Concept";
  return [
    `Refreshed concept: ${label}`,
    ...[...data.definitions, ...data.relations].map(objectLine),
    `Coverage: ${data.coverage.status}.`,
  ];
}

export const tellCommand: Command = {
  name: "tell",
  usage:
    'tell "<statement>" [--claim CLAIM_ID|--world-claim TOKEN] [--mode replace_object|retract|reclassify_mode] [--object TEXT|--object-ref TOKEN|--object-vocabulary ID] [--perspective-mode suggested|hypothetical|questioned] [--refresh-concept-ref TOKEN] [--since TIME] [--until TIME] [--dry-run] [--json] [--verbose]',
  summary: "correct a claim; rewrite affected canon in the same pass",
  schema: TELL_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...TELL_SCHEMA.options],
      flags: [...TELL_SCHEMA.flags],
    });
    const statement = parsed.positionals[0];
    if (statement === undefined || parsed.positionals.length !== 1) {
      throw new UsageError(this.usage);
    }

    const claim = parsed.options.get("--claim");
    const worldClaim = parsed.options.get("--world-claim");
    const since = parsed.options.get("--since");
    const until = parsed.options.get("--until");
    if (claim !== undefined && worldClaim !== undefined) throw new UsageError(this.usage);
    if (worldClaim !== undefined && !isWorldWireToken(worldClaim)) throw new UsageError(this.usage);
    const mode = parsed.options.get("--mode");
    const objectText = parsed.options.get("--object");
    const objectRef = parsed.options.get("--object-ref");
    const objectVocabulary = parsed.options.get("--object-vocabulary");
    const perspective = parsed.options.get("--perspective-mode");
    const refresh = parsed.options.get("--refresh-concept-ref");
    if (worldClaim === undefined && WORLD_ONLY.some((option) => parsed.options.has(option))) throw new UsageError(this.usage);
    if (
      (mode !== undefined && !(MODES as readonly string[]).includes(mode)) ||
      (perspective !== undefined && !(PERSPECTIVE_MODES as readonly string[]).includes(perspective)) ||
      (mode === "reclassify_mode") !== (perspective !== undefined) ||
      [objectText, objectRef, objectVocabulary].filter((value) => value !== undefined).length > 1 ||
      ((objectText !== undefined || objectRef !== undefined || objectVocabulary !== undefined) && mode !== undefined && mode !== "replace_object") ||
      (objectRef !== undefined && !isWorldWireToken(objectRef)) ||
      (refresh !== undefined && !isWorldWireToken(refresh))
    )
      throw new UsageError(this.usage);

    return withVault(io, async (ctx) => {
      try {
        if (worldClaim !== undefined) {
          const served = await serveCorrect(
            {
              db: ctx.db,
              vaultPath: ctx.vaultPath,
              principal: OWNER,
              ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
            },
            {
              statement,
              target: { world_claim: { kind: "claim", token: worldClaim } },
              ...(mode === undefined ? {} : { mode: mode as NonNullable<CorrectArgs["mode"]> }),
              ...(perspective === undefined ? {} : { perspective_mode: perspective as NonNullable<CorrectArgs["perspective_mode"]> }),
              ...(objectText === undefined ? {} : { object: { kind: "literal" as const, value: objectText } }),
              ...(objectRef === undefined ? {} : { object: { kind: "node" as const, ref: { kind: "object" as const, token: objectRef } } }),
              ...(objectVocabulary === undefined ? {} : { object: { kind: "vocabulary" as const, id: objectVocabulary } }),
              ...(refresh === undefined ? {} : { refresh_world: { operation: "concept" as const, concept: { kind: "object" as const, token: refresh } } }),
              ...(parsed.flags.has("--dry-run") ? { dry_run: true } : {}),
            },
          );
          if (served.data === undefined) throw new CorrectError("target_required", "world claim correction was not recorded");
          const pending = served.data.recovery_pending !== undefined;
          const derived = pending ? { degraded: [] as string[] } : tryRefreshDerived(ctx.db, ctx.vaultPath);
          if (parsed.flags.has("--json")) {
            io.out(jsonEnvelope("tell", pending ? "error" : derived.degraded.length > 0 ? "degraded" : "ok", served, { degraded: derived.degraded }));
          } else {
            io.out(served.data.answer);
            if (parsed.flags.has("--verbose")) for (const pageWrite of served.data.rewritten) io.out(pageWrite.diff.trimEnd());
            const view = served.data.refreshedWorld;
            if (view !== undefined && view !== null) {
              // The correction stands whatever the read found.
              if ("result" in view && view.result.status === "unavailable") io.err("refresh: the corrected concept could not be read; the correction is recorded. Read it with kizuki world --operation concept.");
              else for (const line of renderRefreshed(view)) io.out(line);
            }
          }
          for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
          return pending ? 1 : 0;
        }
        const result = await correct(
          { db: ctx.db, vault_path: ctx.vaultPath, ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }) },
          {
            statement,
            ...(claim === undefined ? {} : { target: { claim_id: claim } }),
            ...(since === undefined && until === undefined
              ? {}
              : { scope: { ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) } }),
            ...(parsed.flags.has("--dry-run") ? { dry_run: true } : {}),
          },
        );
        const pending = result.recovery_pending !== undefined;
        const derived = pending ? { degraded: [] as string[] } : tryRefreshDerived(ctx.db, ctx.vaultPath);
        if (parsed.flags.has("--json")) {
          io.out(
            jsonEnvelope(
              "tell",
              pending ? "error" : derived.degraded.length > 0 ? "degraded" : "ok",
              result,
              { degraded: derived.degraded },
            ),
          );
          return pending ? 1 : 0;
        }
        io.out(result.answer);
        if (parsed.flags.has("--verbose")) {
          for (const pageWrite of result.rewritten) {
            io.out(pageWrite.diff.trimEnd());
          }
        }
        for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
        return pending ? 1 : 0;
      } catch (error) {
        if (error instanceof CorrectError) {
          io.err(error.message);
          return 1;
        }
        throw error;
      }
    });
  },
};
