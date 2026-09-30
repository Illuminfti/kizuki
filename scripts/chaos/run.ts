import { join } from "node:path";
import { tmpdir } from "node:os";
import { OPERATIONS, runCampaign } from "./harness";
import type { CampaignOptions, Operation } from "./harness";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("bun scripts/chaos/run.ts [--ci|--local] [--seed N] [--trials N] [--operation NAME] [--max-delay-ms N] [--artifacts DIR]\n");
  process.exit(0);
}
const options: CampaignOptions = { seed: 17, trials: args.includes("--local") ? 1000 : 2, artifacts: join(tmpdir(), "kizuki-chaos-failures") };
try {
  if (args.includes("--ci") && args.includes("--local")) throw new Error("choose_one_mode");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--ci" || arg === "--local") continue;
    const value = args[++index];
    if (value === undefined) throw new Error("missing_option_value");
    switch (arg) {
      case "--seed": options.seed = Number(value); break;
      case "--trials": options.trials = Number(value); break;
      case "--max-delay-ms": options.maxDelayMs = Number(value); break;
      case "--operation":
        if (!OPERATIONS.includes(value as Operation)) throw new Error("unknown_operation");
        options.operations = [value as Operation]; break;
      case "--artifacts": options.artifacts = value; break;
      default: throw new Error("unknown_option");
    }
  }
  options.onTrial = trial => process.stderr.write(`${trial.operation} trial=${trial.trial} delay_ms=${trial.delay_ms} ${trial.killed ? "SIGKILL" : "completed"} ${trial.failure ?? "ok"}\n`);
  const report = await runCampaign(options);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "chaos_failed") + "\n");
  process.exitCode = 2;
}
