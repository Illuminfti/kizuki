import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PurgeError,
  liftPurgeSuppressions,
  listPurgeSuppressions,
  previewPurge,
  resolvePurgeConnectorId,
  runPurge,
  resumePurge,
} from "@kizuki/core";
import type { PurgeFilter, PurgeOutcome, PurgePreview } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { listHostConnections } from "../connections";
import { withReadVault, withVault } from "../context";
import { refreshAndPublishDerived } from "../derived";
import { jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const PURGE_IRREVERSIBLE =
  "Purge physically deletes event evidence. Undo cannot resurrect purged events. Canon rewrites stay reversible by receipt.";

function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function isExactSelector(filter: PurgeFilter): boolean {
  return filter.event_id !== undefined || filter.source_record_id !== undefined;
}

function describeSelector(filter: PurgeFilter): string {
  if (filter.event_id !== undefined) return `event_id=${filter.event_id}`;
  if (filter.subject_handle !== undefined) {
    const parts = [`connector_id=${filter.connector_id}`, `subject_handle=${filter.subject_handle}`];
    if (filter.source_key !== undefined) parts.push(`source_key=${filter.source_key}`);
    return parts.join(" ");
  }
  if (filter.connector_id !== undefined && filter.source_record_id !== undefined) {
    return `connector_id=${filter.connector_id} source_record_id=${filter.source_record_id}`;
  }
  if (filter.connector_id !== undefined) return `connector_id=${filter.connector_id}`;
  return "filter";
}

function printPreview(io: CliIo, preview: PurgePreview): void {
  io.out(
    `dry-run: ${plural(preview.event_count, "event")}; ${plural(preview.affected_pages.length, "page")}; retrieval ${preview.retrieval}`,
  );
  io.out(`selector ${describeSelector(preview.filter)}`);
  if (preview.connector_ids.length > 0) {
    io.out(`connectors ${preview.connector_ids.join(", ")}`);
  }
  if (preview.event_ids.length > 0) {
    io.out(`event_ids ${preview.event_ids.join(", ")}`);
  }
  if (preview.affected_pages.length > 0) {
    io.out(`pages ${preview.affected_pages.join(", ")}`);
  }
  if (preview.uncertain_pages.length > 0) {
    io.out(`uncertain ${preview.uncertain_pages.join(", ")}`);
  }
}

/** Paths where a just-purged source record is still present at its source. */
function stillAtSource(
  ctx: { db: Parameters<typeof listPurgeSuppressions>[0]; store: Parameters<typeof listHostConnections>[1] },
  outcome: PurgeOutcome,
): string[] {
  const receipts = new Set(outcome.receipts.map((receipt) => receipt.receipt_id));
  const found = new Set<string>();
  for (const record of listPurgeSuppressions(ctx.db)) {
    if (!receipts.has(record.receipt_id)) continue;
    for (const { state } of listHostConnections(ctx.db, ctx.store, record.connector_id)) {
      const root = state?.config.path;
      if (root === undefined) continue;
      const path = join(root, record.source_record_id);
      if (existsSync(path)) found.add(path);
    }
  }
  return [...found].sort();
}

export const PURGE_SCHEMA = {
  options: ["--event", "--subject", "--source", "--connector", "--record", "--reason", "--verify", "--lift-suppression"],
  flags: ["--include-aliases", "--json", "--dry-run", "--confirm", "--allow-empty", "--suppressions"],
  irreversible: true,
} as const satisfies CommandHelpSchema;

export const purgeCommand: Command = {
  name: "purge",
  usage:
    "purge (--event ID | --connector ID [--record ID | --subject ID [--source KEY] [--include-aliases]] | --verify RECEIPT) [--reason TEXT] [--dry-run] [--confirm] [--allow-empty] [--json] | purge --suppressions [--json] | purge --lift-suppression RECEIPT [--json]",
  summary:
    "physically delete matching events, hold affected pages, and prove absence",
  schema: PURGE_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...PURGE_SCHEMA.options],
      flags: [...PURGE_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const asJson = parsed.flags.has("--json");
    const dryRun = parsed.flags.has("--dry-run");
    const confirm = parsed.flags.has("--confirm");
    const allowEmpty = parsed.flags.has("--allow-empty");

    const liftId = parsed.options.get("--lift-suppression");
    const listing = parsed.flags.has("--suppressions");
    if (liftId !== undefined || listing) {
      if (
        (liftId !== undefined && listing) ||
        ["--event", "--subject", "--source", "--connector", "--record", "--reason", "--verify"].some((name) => parsed.options.has(name)) ||
        parsed.flags.has("--include-aliases") || dryRun || confirm || allowEmpty
      ) {
        throw new UsageError(this.usage);
      }
      if (liftId === undefined) {
        return withReadVault(io, async (ctx) => {
          const records = listPurgeSuppressions(ctx.db);
          if (asJson) io.out(jsonEnvelope("purge", "ok", { suppressions: records }));
          else if (records.length === 0) io.out("no purged source record is being refused");
          else {
            for (const record of records) {
              io.out(`${record.connector_id}  ${record.source_record_id}  purge ${record.receipt_id}  ${record.purged_at}`);
            }
            io.out("lift with: kizuki purge --lift-suppression RECEIPT");
          }
          return 0;
        });
      }
      return withVault(io, async (ctx) => {
        const lifted = liftPurgeSuppressions(ctx.db, liftId, new Date().toISOString());
        if (asJson) io.out(jsonEnvelope("purge", lifted.length > 0 ? "ok" : "error", { lifted }));
        else if (lifted.length > 0) io.out(`lifted ${plural(lifted.length, "suppression")}; the next sync may capture those source records again`);
        if (lifted.length === 0) io.err(`no active suppression for purge ${liftId}`);
        return lifted.length > 0 ? 0 : 1;
      });
    }

    const verifyId = parsed.options.get("--verify");
    if (verifyId !== undefined) {
      if (
        parsed.options.has("--event") ||
        parsed.options.has("--subject") ||
        parsed.options.has("--source") ||
        parsed.options.has("--connector") ||
        parsed.options.has("--record") ||
        parsed.options.has("--reason") ||
        parsed.flags.has("--include-aliases") ||
        dryRun ||
        confirm ||
        allowEmpty
      ) {
        throw new UsageError(this.usage);
      }
      return withVault(io, async (ctx) => {
        const report = await resumePurge(ctx.db, ctx.vaultPath, verifyId, ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval });
        // Verification rewrites held canon; the derived cursor has to follow the
        // shrunk ledger or doctor and query read the vault as permanently stale.
        const derived = await refreshAndPublishDerived(ctx.db, ctx.vaultPath, ctx.retrieval);
        if (asJson) {
          io.out(
            jsonEnvelope("purge", report.ok ? "ok" : "error", {
              ...report,
              ops: report.operations.map((op) => ({
                op_id: op.op_id,
                store: op.store,
                state: op.state,
                checked: op.proof?.checked ?? 0,
                found: op.proof?.found ?? [],
                provenance: op.proof?.provenance ?? { checked: 0, found: [] },
              })),
            }, { degraded: derived.degraded }),
          );
        } else {
          for (const op of report.operations) {
            const proof = op.proof;
            io.out(
              `${pad(op.store, 23)} checked ${proof?.checked ?? 0}  found ${proof?.found.length ?? 0}   ${op.state}   provenance checked ${proof?.provenance.checked ?? 0}  found ${proof?.provenance.found.length ?? 0}`,
            );
          }
          for (const proof of report.stores) {
            io.out(
              `${pad(proof.store, 23)} checked ${proof.checked}  found ${proof.found.length}   ${proof.found.length === 0 ? "clean" : `still holds ${proof.found.join(", ")}`}`,
            );
          }
          const hold = report.hold_lifted ? "hold lifted" : "hold remains";
          io.out(
            `${pad("canon rewrite", 23)} pages rewritten ${report.pages_rewritten}    ${hold}`,
          );
          for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
          if (!report.ok) {
            // Every store proof is settled, so a repeat run replays the same
            // failing canon rewrite. Name the pages instead of inviting a retry
            // that cannot change the outcome.
            const rewriteStalled =
              report.held_pages.length > 0 &&
              report.operations.every((op) => op.state === "done");
            if (rewriteStalled) {
              io.err(
                `hold remains on ${plural(report.held_pages.length, "page")}: ${report.held_pages.join(", ")}`,
              );
              io.err(
                "every store proof is complete; the canon rewrite of those pages failed, so repeating --verify alone cannot lift the hold",
              );
              io.err(
                `check kizuki doctor, and that each held page and its parent directories are owned by you and are not group- or world-writable, then retry: kizuki purge --verify ${verifyId}`,
              );
            } else {
              io.err(`retry: kizuki purge --verify ${verifyId}`);
            }
          }
        }
        return report.ok ? 0 : 1;
      }, { retrieval: "optional" });
    }

    const reason = parsed.options.get("--reason");
    const eventId = parsed.options.get("--event");
    const subject = parsed.options.get("--subject");
    const source = parsed.options.get("--source");
    const connector = parsed.options.get("--connector");
    const record = parsed.options.get("--record");
    const includeAliases = parsed.flags.has("--include-aliases");
    const selectors = [eventId, connector].filter(
      (value) => value !== undefined,
    );
    if (subject !== undefined && connector === undefined) {
      throw new UsageError("subject purge requires --connector ID; a bare subject id has no namespace");
    }
    if (reason === undefined || selectors.length !== 1) {
      throw new UsageError(this.usage);
    }
    if (record !== undefined && connector === undefined) {
      throw new UsageError(this.usage);
    }
    if ((subject !== undefined && record !== undefined) || (source !== undefined && subject === undefined)) {
      throw new UsageError(this.usage);
    }
    if (includeAliases && subject === undefined) {
      throw new UsageError(this.usage);
    }

    return (dryRun ? withReadVault : withVault)(io, async (ctx) => {
      let filter: PurgeFilter;
      if (eventId !== undefined) filter = { event_id: eventId };
      else {
        filter = {
          connector_id: resolvePurgeConnectorId(ctx.db, connector ?? ""),
        };
        if (record !== undefined) filter.source_record_id = record;
        if (subject !== undefined) filter.subject_handle = subject;
        if (source !== undefined) filter.source_key = source;
      }

      if (dryRun) {
        const preview = previewPurge(ctx.db, ctx.vaultPath, filter, reason, {
          include_aliases: includeAliases,
        });
        if (asJson) {
          const empty = preview.event_count === 0;
          io.out(
            jsonEnvelope(
              "purge",
              empty && !allowEmpty ? "error" : "ok",
              { ...preview, dry_run: true },
            ),
          );
        } else {
          printPreview(io, preview);
        }
        if (preview.event_count === 0 && !allowEmpty) {
          io.err(`purge matched no events for ${describeSelector(preview.filter)}`);
          return 1;
        }
        return 0;
      }

      if (!isExactSelector(filter) && !confirm) {
        throw new UsageError(
          "broad purge requires --confirm (or --dry-run)",
        );
      }

      io.err(PURGE_IRREVERSIBLE);
      try {
        const outcome = await runPurge(ctx.db, ctx.vaultPath, filter, reason, {
          include_aliases: includeAliases,
          allow_empty: allowEmpty,
          ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
        });
        // The purge deleted events out from under the derived cursor. Without a
        // refresh the counts never reconcile and every later read reports
        // index-behind-ledger.
        const derived = await refreshAndPublishDerived(ctx.db, ctx.vaultPath, ctx.retrieval);
        const present = stillAtSource(ctx, outcome);
        if (asJson) {
          io.out(
            jsonEnvelope("purge", "ok", {
              ...outcome,
              irreversible_events: true,
              undo_restores_canon_only: true,
              source_records_still_present: present,
            }, { degraded: derived.degraded }),
          );
        } else {
          io.out(
            `purged ${plural(outcome.receipts.length, "event")}; held ${plural(outcome.canon_holds.length, "page")}; ${plural(outcome.purge_ops.length, "store op")} pending`,
          );
          const receipt = outcome.receipts[0];
          if (receipt !== undefined) {
            io.out(`receipt ${receipt.receipt_id}`);
            if (includeAliases) io.out(receipt.reason);
          }
          io.out(PURGE_IRREVERSIBLE);
          for (const op of outcome.purge_ops) {
            io.out(`op ${op.store} state=${op.state}`);
          }
          const erased = outcome.erased;
          io.out(
            `erased ${plural(erased.claims, "claim")}, ${plural(erased.proposals, "proposal")}, ${plural(erased.archive_copies.length, "archive file")}${erased.archive_copies.length > 0 ? `: ${erased.archive_copies.join(", ")}` : ""}; ledger files ${erased.database_sealed ? "compacted" : "not compacted, run kizuki purge --verify to retry"}`,
          );
          for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
          for (const path of present) {
            io.err(
              `warning: the source record still exists at ${path}. Remove it or move it out of the source, or a later sync will refuse it. Allow it again with: kizuki purge --lift-suppression ${outcome.receipts[0]?.receipt_id ?? "RECEIPT"}`,
            );
          }
        }
        return 0;
      } catch (error) {
        if (error instanceof PurgeError && error.code === "no_match") {
          io.err(error.message);
          return 1;
        }
        throw error;
      }
    });
  },
};
