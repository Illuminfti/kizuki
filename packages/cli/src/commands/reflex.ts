import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { OWNER } from "@kizuki/core";
import { assessReflex, parseReflexRequest, renderReflexHtml } from "@kizuki/core/reflex";
import type { ReflexRequest } from "@kizuki/core/reflex";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { openReflexRuntime } from "../reflex-runtime";
import type { ReflexRuntime } from "../reflex-runtime";
import type { Command, CommandHelpSchema } from "./index";

const MAX_REQUEST_BYTES = 16_384;
/** Read only the explicit regular file, without following a symlink or blocking on a FIFO. */
export function readReflexRequestFile(path: string): ReflexRequest {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, used);
      if (count === 0) break;
      used += count;
    }
    if (used > MAX_REQUEST_BYTES) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)));
    return parseReflexRequest(value);
  } catch { throw new UsageError("invalid Reflex request file; use bounded JSON with assumptions and event_ids"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export const REFLEX_SCHEMA = {
  options: ["--request", "--format"], flags: ["--allow-model"], defaults: { "--format": "json" },
  bounds: { "--request": "regular JSON file, at most 16384 bytes", "--format": "json|html" },
} as const satisfies CommandHelpSchema;
export const reflexCommand: Command = {
  name: "reflex", usage: "reflex --request FILE [--format json|html] [--allow-model]",
  summary: "check plan assumptions against authorized memory; never an execution permit",
  schema: REFLEX_SCHEMA,
  async run(io, args) {
    const parsed = parseArguments(args, { options: [...REFLEX_SCHEMA.options], flags: [...REFLEX_SCHEMA.flags] });
    const file = parsed.options.get("--request");
    const format = parsed.options.get("--format") ?? "json";
    if (parsed.positionals.length !== 0 || file === undefined || !["json", "html"].includes(format)) throw new UsageError(this.usage);
    const request = readReflexRequestFile(file); // Validate before opening the vault or a credential.
    const allowModel = parsed.flags.has("--allow-model");
    return withReadVault(io, async ctx => {
      let runtime: ReflexRuntime | undefined;
      try {
        if (allowModel) runtime = await openReflexRuntime(ctx.vaultPath, io.env);
        else io.err("Model evaluation is disabled. --allow-model opts in to the configured SystemOne port; each source still requires exact-destination consent.");
        const report = await assessReflex({ db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER }, request,
          runtime?.systemone === undefined ? {} : { systemone: runtime.systemone });
        ctx.assertCurrent(); runtime?.assertCurrent();
        if (report.status === "unavailable") io.err(`Reflex unavailable: ${report.reason}. Unknown is not approval.`);
        io.out(format === "html" ? renderReflexHtml(report) : JSON.stringify(report, null, 2));
        // Success means the assessment completed, not that the proposed action is safe or authorized.
        return report.status === "assessed" ? 0 : 1;
      } finally { await runtime?.close(); }
    }, { audit: true, retrieval: "none" });
  },
};
