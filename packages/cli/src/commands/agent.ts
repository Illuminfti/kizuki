import {
  OWNER_AGENT_GRANT,
  addAgent,
  initAgents,
  listAgents,
  revokeAgent,
  rotateToken,
} from "@kizuki/core";
import type { Sensitivity } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import { jsonLine, table } from "../output";
import type { CliIo, Command } from "./index";

const USAGE =
  "agent add <name> [--owner-agent] [--json] | agent list [--json] | agent revoke <name> | agent rotate <name> [--json]";

/**
 * A minted token is shown exactly once, on stdout, and nowhere else. The
 * stderr hint never repeats it (RFC 0002 §8.4; CLI never prints tokens).
 */
function printMinted(
  io: CliIo,
  name: string,
  agentId: string,
  token: string,
  ceiling: Sensitivity,
  json: boolean,
): void {
  io.err(`token for ${name} is shown once; store it now, it cannot be recovered`);
  if (json) {
    io.out(jsonLine({ name, agent_id: agentId, token, ceiling }));
  } else {
    io.out(token);
  }
}

export const agentCommand: Command = {
  name: "agent",
  usage: USAGE,
  summary: "add, list, revoke and rotate scoped agent identities",
  async run(io: CliIo, args: string[]): Promise<number> {
    const [verb, ...rest] = args;

    if (verb === "add") {
      const parsed = parseArguments(rest, { flags: ["--owner-agent", "--json"] });
      const [name] = requirePositional(parsed.positionals, 1);
      if (name === undefined) throw new UsageError(this.usage);

      return withVault(io, async (ctx) => {
        initAgents(ctx.db);
        const patch = parsed.flags.has("--owner-agent") ? OWNER_AGENT_GRANT : {};
        const created = addAgent(ctx.db, name, patch);
        const row = listAgents(ctx.db).find(
          (entry) => entry.agent_id === created.agent.agent_id,
        );
        if (row === undefined) throw new Error(`agent ${name} does not exist`);
        printMinted(
          io,
          row.name,
          row.agent_id,
          created.token,
          row.grant.ceiling,
          parsed.flags.has("--json"),
        );
        return 0;
      });
    }

    if (verb === "list") {
      const parsed = parseArguments(rest, { flags: ["--json"] });
      if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

      return withVault(io, async (ctx) => {
        initAgents(ctx.db);
        const rows = listAgents(ctx.db);
        if (parsed.flags.has("--json")) {
          for (const row of rows) {
            io.out(
              jsonLine({
                name: row.name,
                agent_id: row.agent_id,
                ceiling: row.grant.ceiling,
                tools: row.grant.tools.length,
                revoked_at: row.revoked_at,
              }),
            );
          }
          return 0;
        }
        const lines = table([
          ["name", "agent_id", "ceiling", "tools", "revoked_at"],
          ...rows.map((row) => [
            row.name,
            row.agent_id,
            row.grant.ceiling,
            String(row.grant.tools.length),
            row.revoked_at ?? "",
          ]),
        ]);
        for (const line of lines) io.out(line);
        return 0;
      });
    }

    if (verb === "revoke") {
      const parsed = parseArguments(rest, {});
      const [name] = requirePositional(parsed.positionals, 1);
      if (name === undefined) throw new UsageError(this.usage);

      return withVault(io, async (ctx) => {
        initAgents(ctx.db);
        revokeAgent(ctx.db, name);
        io.out(`revoked ${name}`);
        return 0;
      });
    }

    if (verb === "rotate") {
      const parsed = parseArguments(rest, { flags: ["--json"] });
      const [name] = requirePositional(parsed.positionals, 1);
      if (name === undefined) throw new UsageError(this.usage);

      return withVault(io, async (ctx) => {
        initAgents(ctx.db);
        const token = rotateToken(ctx.db, name);
        const row = listAgents(ctx.db).find((entry) => entry.name === name);
        if (row === undefined) throw new Error(`agent ${name} does not exist`);
        printMinted(io, row.name, row.agent_id, token, row.grant.ceiling, parsed.flags.has("--json"));
        return 0;
      });
    }

    throw new UsageError(this.usage);
  },
};
