import type { PurgeFilter } from "@kizuki/core";
import { purgeEvents } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { resolveConnectorId } from "../connections";
import { withVault } from "../context";
import type { CliIo, Command } from "./index";

export const purgeCommand: Command = {
  name: "purge",
  usage: "purge (--event ID | --subject ID | --connector ID) --reason TEXT",
  summary: "physically delete matching events and file purge-review holds",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--event", "--subject", "--connector", "--reason"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const reason = parsed.options.get("--reason");
    const eventId = parsed.options.get("--event");
    const subject = parsed.options.get("--subject");
    const connector = parsed.options.get("--connector");
    const selectors = [eventId, subject, connector].filter(
      (value) => value !== undefined,
    );
    if (reason === undefined || selectors.length !== 1) {
      throw new UsageError(this.usage);
    }

    let filter: PurgeFilter;
    if (eventId !== undefined) filter = { event_id: eventId };
    else if (subject !== undefined) filter = { subject_handle: subject };
    else filter = { connector_id: resolveConnectorId(connector ?? "") };

    return withVault(io, async (ctx) => {
      const outcome = purgeEvents(ctx.db, ctx.vaultPath, filter, reason);
      io.out(
        `purged=${outcome.receipts.length} withdrawn=${outcome.withdrawn_proposals.length} holds=${outcome.canon_holds.length}`,
      );
      for (const receipt of outcome.receipts) {
        io.out(`receipt ${receipt.receipt_id} event=${receipt.event_id}`);
      }
      for (const hold of outcome.canon_holds) {
        io.out(`hold ${hold.page_path} proposal=${hold.proposal_id}`);
      }
      return 0;
    });
  },
};
