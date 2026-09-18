import { analyzeChange, preflight, simulateChange, traceImpact, type ReflexHost } from "../src/index";
import { fixture, response } from "./fixtures";

async function main() {
  const { snapshot, change } = fixture();
  const host: ReflexHost = { async isCurrent() { return true; }, async evaluateAuthorized() { return response(); } };
  const report = process.argv.includes("--rehearsal")
    ? await analyzeChange(snapshot, change, { host })
    : simulateChange(snapshot, change);
  console.log(JSON.stringify({
    disclaimer: "Synthetic demonstration. No real vault, live Jev request, or action execution.",
    report,
    trace: traceImpact(snapshot, change, "fact:local", "action:website"),
    preflight: preflight(report, snapshot.binding, [
      { id: "publish-website", assumptions: [{ node_id: "action:website", revision: "r4" }] },
      { id: "enable-classifier", assumptions: [{ node_id: "action:enable", revision: "r5" }] },
      { id: "local-typecheck", assumptions: [{ node_id: "action:lint", revision: "r6" }] },
    ]),
  }, null, 2));
}
void main().catch(() => {
  console.error("reflex demo failed");
  process.exitCode = 1;
});
