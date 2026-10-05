import { OWNER, compareRfc3339, isRfc3339, serveTimeline } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { clean, jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;

function identifier(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ID.test(value)) throw new UsageError(`invalid ${name}`);
  return value;
}

function instant(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isRfc3339(value)) throw new UsageError(`invalid ${name}`);
  return value;
}

function budget(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError("invalid --budget");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 128 || parsed > 8_192) throw new UsageError("invalid --budget");
  return parsed;
}

function hash(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!HASH.test(value)) throw new UsageError(`invalid ${name}`);
  return value;
}

export const HISTORY_SCHEMA = {
  options: ["--day", "--since", "--until", "--subject", "--connector", "--kind", "--budget", "--snapshot", "--node"],
  flags: ["--json"],
  defaults: { "--budget": "1024" },
  bounds: { "--budget": "128..8192", "--snapshot": "sha256", "--node": "sha256" },
} as const satisfies CommandHelpSchema;

export const historyCommand: Command = {
  name: "history",
  usage: "history [--day YYYY-MM-DD | --since RFC3339 --until RFC3339] [--subject ID] [--connector ID] [--kind ID] [--budget 128..8192] [--snapshot SHA256 --node SHA256] [--json]",
  summary: "navigate authorized captured history through a bounded extractive tree",
  schema: HISTORY_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: HISTORY_SCHEMA.options, flags: HISTORY_SCHEMA.flags });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const snapshot = hash("--snapshot", parsed.options.get("--snapshot"));
    const node = hash("--node", parsed.options.get("--node"));
    if ((snapshot === undefined) !== (node === undefined)) throw new UsageError("--snapshot and --node must be used together");
    const since = instant("--since", parsed.options.get("--since"));
    const until = instant("--until", parsed.options.get("--until"));
    if (since !== undefined && until !== undefined && compareRfc3339(since, "since", until, "until") > 0) throw new UsageError("--since must not be after --until");
    const day = parsed.options.get("--day");
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UsageError("invalid --day");
    const subject = identifier("--subject", parsed.options.get("--subject"));
    const connector_id = identifier("--connector", parsed.options.get("--connector"));
    const kind = identifier("--kind", parsed.options.get("--kind"));
    const budgetBytes = budget(parsed.options.get("--budget"));
    const input = {
      view: "tree" as const,
      ...(day === undefined ? {} : { day }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(subject === undefined ? {} : { subject }),
      ...(connector_id === undefined ? {} : { connector_id }),
      ...(kind === undefined ? {} : { kind }),
      ...(budgetBytes === undefined ? {} : { budget_bytes: budgetBytes }),
      ...(snapshot === undefined ? {} : { snapshot, node: node! }),
    };
    return withReadVault(io, async (ctx) => {
      const envelope = serveTimeline({ db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER }, input);
      ctx.assertCurrent();
      if (parsed.flags.has("--json")) {
        io.out(jsonEnvelope("history", "ok", envelope));
        return 0;
      }
      const data = envelope.data;
      if (data === undefined || !("view" in data) || data.view !== "tree") return 1;
      io.out(`snapshot ${data.snapshot}`);
      io.out(`node ${data.node.node}${data.node.event_id === undefined ? "" : ` event ${data.node.event_id}`}`);
      if (data.node.text.length > 0) io.out(clean(data.node.text));
      for (const child of data.node.children ?? []) io.out(`child ${child.node} ${child.source_ref}`);
      io.err(data.notice);
      return 0;
    }, { audit: true, retrieval: "none" });
  },
};
