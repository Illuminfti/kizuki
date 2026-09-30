import {
  OWNER,
  PACKET_PURPOSES,
  compareRfc3339,
  isRfc3339,
  serveContextPacket,
} from "@kizuki/core";
import type { ContextPacketArgs, PacketPurpose } from "@kizuki/core";
import { PACKET_V2_SCHEMA } from "@kizuki/core/world";
import type { ContextPacketDataV2 } from "@kizuki/core/world";
import { UsageError, parseArguments } from "../args";
import { withReadVault, withVault } from "../context";
import { jsonEnvelope } from "../output";
import { RESPONSE_CONTRACT_BOUND, RESPONSE_CONTRACT_OPTION, cliResultV2, contractFailure, responseContract, serveV2 } from "../response-contract";
import type { CliIo, Command, CommandHelpSchema } from "./index";

function parseBudget(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new UsageError("invalid --budget");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 50 || value > 2_000) {
    throw new UsageError("invalid --budget");
  }
  return value;
}

function parseQuery(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Match the context packet's text contract before opening its audited vault.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) {
    throw new UsageError("invalid arguments: query: must not contain control characters");
  }
  if (raw.trim().length === 0) {
    throw new UsageError("invalid arguments: query: must not be blank");
  }
  if (Array.from(raw).length > 512) {
    throw new UsageError("invalid arguments: query: must be at most 512 characters");
  }
  return raw;
}

function parseTaskEvent(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(raw)) {
    throw new UsageError("invalid arguments: task_event_id: must be an identifier of at most 64 characters");
  }
  return raw;
}

function parseTaskIntegrity(raw: string | undefined, event: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (event === undefined) {
    throw new UsageError("invalid arguments: task_event_id: required to read task sections");
  }
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new UsageError("invalid arguments: task_integrity: must be a sha256 hex digest");
  }
  return raw;
}

function parseWindowBound(field: "since" | "until", raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isRfc3339(raw)) {
    throw new UsageError(`invalid arguments: ${field}: must be an RFC3339 timestamp`);
  }
  return raw;
}

function parseContextWindow(options: Map<string, string>): { since?: string; until?: string } {
  const since = parseWindowBound("since", options.get("--since"));
  const until = parseWindowBound("until", options.get("--until"));
  if (since !== undefined && until !== undefined && compareRfc3339(since, "since", until, "until") > 0) {
    throw new UsageError("invalid arguments: since: must not be after until");
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

export const CONTEXT_SCHEMA = {
  options: ["--purpose", "--budget", "--query", "--since", "--until", "--task-event", "--task-integrity", RESPONSE_CONTRACT_OPTION],
  flags: ["--json"],
  defaults: { "--purpose": "session" },
  bounds: {
    "--purpose": "session|recall|correction|audit",
    "--budget": "50..2000",
    "--since": "RFC3339",
    "--until": "RFC3339",
    "--task-event": "identifier",
    "--task-integrity": "sha256",
    [RESPONSE_CONTRACT_OPTION]: RESPONSE_CONTRACT_BOUND,
  },
} as const satisfies CommandHelpSchema;

type Task = NonNullable<import("@kizuki/core").ContextPacketData["task"]>;

/** What stderr says about a packet, the same for either serving contract. */
function reportPacket(
  io: CliIo,
  facts: {
    retrievalDegraded: readonly string[];
    incomplete: boolean;
    sections: Record<string, number> | undefined;
    task: Task | undefined;
  },
): void {
  if (facts.retrievalDegraded.length > 0) io.err(`degraded=${facts.retrievalDegraded.join(",")}`);
  const { task } = facts;
  const taskTextServed = task?.sections !== undefined
    && Object.values(task.sections).some((items) => items.length > 0);
  if (facts.incomplete) {
    io.err("Context could not be gathered completely. Run kizuki doctor to check the vault.");
  } else if (
    facts.sections !== undefined
    && Object.values(facts.sections).every((count) => count === 0)
    && !taskTextServed
  ) {
    io.err("No matching context fits this packet. Try a broader --query, a larger --budget, or an explicit --since/--until window; use kizuki doctor to check your sources.");
  }
  if (task !== undefined && task.status !== "current") {
    io.err(`task=${task.status}${task.reason === undefined ? "" : ` reason=${task.reason}`}`);
  }
}

export const contextCommand: Command = {
  name: "context",
  usage:
    `context [--purpose session|recall|correction|audit] [--budget N] [--query TEXT] [--since RFC3339] [--until RFC3339] [--task-event ID] [--task-integrity SHA256] [${RESPONSE_CONTRACT_OPTION} ${RESPONSE_CONTRACT_BOUND}] [--json]`,
  summary: "give your agent relevant context, with sources and a token budget",
  schema: CONTEXT_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...CONTEXT_SCHEMA.options],
      flags: [...CONTEXT_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const rawPurpose = parsed.options.get("--purpose") ?? CONTEXT_SCHEMA.defaults["--purpose"];
    if (!(PACKET_PURPOSES as readonly string[]).includes(rawPurpose)) {
      throw new UsageError(this.usage);
    }
    const rawBudget = parsed.options.get("--budget");
    const budget = rawBudget === undefined ? undefined : parseBudget(rawBudget);
    const query = parseQuery(parsed.options.get("--query"));
    const taskEvent = parseTaskEvent(parsed.options.get("--task-event"));
    const taskIntegrity = parseTaskIntegrity(parsed.options.get("--task-integrity"), taskEvent);
    const window = parseContextWindow(parsed.options);

    const request: ContextPacketArgs = {
      purpose: rawPurpose as PacketPurpose,
      ...(budget === undefined ? {} : { budget_tokens: budget }),
      ...(query === undefined ? {} : { query }),
      ...(taskEvent === undefined ? {} : { task_event_id: taskEvent }),
      ...(taskIntegrity === undefined ? {} : { task_integrity: taskIntegrity }),
      ...window,
    };

    const contract = responseContract(parsed.options);
    // The scoped envelope issues its principal reference, which is a ledger write.
    if (contract !== undefined) {
      return withVault(io, async (ctx) => {
        const envelope = await serveV2(
          { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER, ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }), ...(ctx.retrievalUnavailable ? { retrievalUnavailable: ctx.retrievalUnavailable } : {}) },
          "context_packet",
          request as Record<string, unknown>,
          contract,
        );
        const packet = envelope.data as ContextPacketDataV2;
        if (packet.schema !== PACKET_V2_SCHEMA) throw new Error("the packet contract is not the one requested");
        const content = packet.result.status === "unchanged" ? undefined : packet.result.data;
        const retrievalDegraded = content?.retrievalDegraded ?? [];
        const incomplete = retrievalDegraded.includes("context-unavailable");
        reportPacket(io, { retrievalDegraded, incomplete, sections: content?.sections, task: content?.task });
        if (parsed.flags.has("--json")) io.out(cliResultV2("context", envelope));
        else if (content !== undefined) io.out(content.packetMd);
        return incomplete ? 1 : 0;
      }, { retrieval: "optional" }).catch((error: unknown) => contractFailure(io, "context", parsed.flags.has("--json"), error));
    }

    return withReadVault(io, async (ctx) => {
      const envelope = await serveContextPacket(
        { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER, ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }), ...(ctx.retrievalUnavailable ? { retrievalUnavailable: ctx.retrievalUnavailable } : {}) },
        request,
      );
      ctx.assertCurrent();
      const retrievalDegraded = envelope.data?.retrieval_degraded ?? [];
      const incomplete = envelope.data === undefined || envelope.denied.some(
        (entry) => entry.reason === "error",
      );
      reportPacket(io, { retrievalDegraded, incomplete, sections: envelope.data?.sections, task: envelope.data?.task });
      if (parsed.flags.has("--json")) {
        io.out(jsonEnvelope("context", incomplete || retrievalDegraded.length > 0 ? "degraded" : "ok", envelope, {
          degraded: incomplete ? ["context-unavailable", ...retrievalDegraded] : retrievalDegraded,
        }));
      } else if (envelope.data !== undefined) {
        io.out(envelope.data.packet_md);
      }
      return incomplete ? 1 : 0;
    }, { audit: true, retrieval: "optional" });
  },
};
