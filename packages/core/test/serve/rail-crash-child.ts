import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { defineRail, registerRail } from "../../src/serve/rail-registry";
import { runRail } from "../../src/serve/rails";

// Runs the fixture rail in a real process and dies without cleanup.
// usage: bun rail-crash-child.ts <vault> <in-run | after-jsonl | after-db>
const [vault, mode] = process.argv.slice(2);
if (vault === undefined || mode === undefined) throw new Error("vault and mode are required");

const kill = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

registerRail(defineRail({
  id: "fixture-crash",
  summary: "Fixture rail for the crash test.",
  period_s: 300,
  jitter_s: 0,
  expects_output: false,
  run: () => {
    if (mode === "in-run") kill();
    return { status: "ok", events_synced: 1 };
  },
}));

const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
try {
  await runRail(db, vault, "fixture-crash", mode === "in-run" ? {} : { crashAfter: mode as "after-jsonl" | "after-db" });
} catch {
  kill();
}
