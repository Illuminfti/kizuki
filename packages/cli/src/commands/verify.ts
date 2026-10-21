import { verifyWorldCopy } from "@kizuki/core/world";
import { isAbsolute } from "node:path";
import { parseArguments, UsageError } from "../args";
import { jsonEnvelope } from "../output";
import type { Command } from "./index";

export const verifyCommand: Command = {
  name: "verify",
  usage: "verify world --vault /absolute/offline-copy [--json]",
  summary: "audit world state in an offline vault copy without writing to it",
  schema: { options: [], flags: ["--json"] },
  async run(io, args) {
    const parsed = parseArguments(args, { options: [], flags: ["--json"] });
    if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "world") throw new UsageError(this.usage);
    // Never infer the live default vault for an immutable-copy audit.
    if (io.vaultOverride === null || !isAbsolute(io.vaultOverride)) throw new UsageError("verify world requires --vault /absolute/offline-copy");
    const report = verifyWorldCopy(io.vaultOverride);
    if (parsed.flags.has("--json")) io.out(jsonEnvelope("verify", report.ok ? "ok" : "degraded", report));
    else {
      for (const check of report.checks) io.out(`${check.status} ${check.id}`);
      if (report.error !== undefined) io.out(`FAIL ${report.error}`);
    }
    return report.ok ? 0 : 1;
  },
};
