import { LlmError, PRODUCERS, readLlmConfig, runEnrichment } from "@kizuki/llm";
import type { EnrichOptions, EnrichReceipt, ProducerName } from "@kizuki/llm";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { jsonLine } from "../output";
import type { CliIo, Command } from "./index";

const OPTIONS = ["--producers", "--limit", "--since", "--connector", "--event"];
const FLAGS = ["--dry-run", "--json"];

function producerList(raw: string): ProducerName[] {
  const chosen: ProducerName[] = [];
  for (const name of raw.split(",").map((entry) => entry.trim())) {
    const match = PRODUCERS.find((producer) => producer === name);
    if (match === undefined) {
      throw new UsageError(
        `--producers must be a comma-separated subset of ${PRODUCERS.join(",")}`,
      );
    }
    if (!chosen.includes(match)) chosen.push(match);
  }
  if (chosen.length === 0) throw new UsageError("--producers must name one");
  return chosen;
}

function limitValue(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new UsageError("--limit must be an integer between 1 and 10000");
  }
  return value;
}

function ranLine(receipt: EnrichReceipt): string {
  const run = receipt.run;
  const counts = receipt.counts;
  return [
    `enrich run=${run?.run_id ?? ""}`,
    `host=${run?.endpoint_host ?? ""}`,
    `model=${run?.model ?? ""}`,
    `considered=${counts.considered}`,
    `sent=${counts.sent}`,
    `requests=${counts.requests}`,
    `proposals=${counts.proposals_filed}`,
    `duplicates=${counts.duplicates}`,
    `suppressed=${counts.suppressed}`,
    `rejected=${counts.rejected_outputs}`,
    `empty=${counts.empty_outputs}`,
    `errors=${counts.errors}`,
    `skipped_unlabeled=${counts.skipped_unlabeled}`,
    `skipped_ceiling=${counts.skipped_ceiling}`,
    `skipped_done=${counts.skipped_done}`,
    `skipped_short=${counts.skipped_short}`,
    `skipped_existing=${counts.skipped_existing}`,
    `stopped=${run?.stopped ?? ""}`,
  ].join(" ");
}

function dryRunLine(receipt: EnrichReceipt): string {
  const counts = receipt.counts;
  return [
    "enrich dry_run=true",
    `would_send=${counts.would_send}`,
    `requests_estimate=${counts.requests}`,
    `input_chars=${counts.input_chars}`,
    `skipped_unlabeled=${counts.skipped_unlabeled}`,
    `skipped_ceiling=${counts.skipped_ceiling}`,
    `skipped_done=${counts.skipped_done}`,
    `skipped_short=${counts.skipped_short}`,
  ].join(" ");
}

export const enrichCommand: Command = {
  name: "enrich",
  usage:
    "enrich [--producers LIST] [--limit N] [--since RFC3339] [--connector ID] [--event ID] [--dry-run] [--json]",
  summary: "ask the configured model endpoint for review-queue drafts",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: OPTIONS, flags: FLAGS });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const producers = parsed.options.get("--producers");
    const limit = parsed.options.get("--limit");
    const since = parsed.options.get("--since");
    const connector = parsed.options.get("--connector");
    const event = parsed.options.get("--event");
    const asJson = parsed.flags.has("--json");

    const opts: EnrichOptions = {
      env: io.env,
      ...(producers === undefined
        ? {}
        : { producers: producerList(producers) }),
      ...(limit === undefined ? {} : { limit: limitValue(limit) }),
      ...(since === undefined ? {} : { since }),
      ...(connector === undefined ? {} : { connector_id: connector }),
      ...(event === undefined ? {} : { event_id: event }),
      ...(parsed.flags.has("--dry-run") ? { dry_run: true } : {}),
    };

    return withVault(io, async (ctx) => {
      let receipt: EnrichReceipt;
      try {
        receipt = await runEnrichment(ctx.db, ctx.vaultPath, opts);
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        io.err(`error: llm ${error.code}: ${error.message}`);
        return 1;
      }
      if (asJson) io.out(jsonLine(receipt));

      if (receipt.status === "unconfigured") {
        io.err(
          "error: no model endpoint configured; run: kizuki llm set --base-url URL --model NAME",
        );
        return 1;
      }
      if (receipt.status === "dry_run") {
        if (!asJson) io.out(dryRunLine(receipt));
        return 0;
      }

      if (!asJson) io.out(ranLine(receipt));
      for (const failure of receipt.request_errors) {
        const status =
          failure.status === null ? "" : ` status=${failure.status}`;
        io.err(
          `error: llm ${failure.code}${status} event=${failure.event_id} producer=${failure.producer}`,
        );
      }
      if (
        receipt.counts.skipped_unlabeled > 0 &&
        readLlmConfig(ctx.vaultPath)?.unlabeled === "skip"
      ) {
        io.err(
          `note: ${receipt.counts.skipped_unlabeled} events have no sensitivity hint and were not sent; kizuki llm set --unlabeled send includes them`,
        );
      }
      return receipt.counts.errors > 0 ||
        receipt.run?.stopped === "consecutive_errors"
        ? 1
        : 0;
    });
  },
};
