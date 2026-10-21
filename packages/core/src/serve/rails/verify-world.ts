import { inspectWorldIntegrity } from "../../world/verify";
import { defineRail } from "../rail-definition";

export const VERIFY_WORLD_RAIL = defineRail({
  id: "verify-world", period_s: 7 * 24 * 60 * 60, jitter_s: 0,
  summary: "Verifies world-model integrity and retains every result.",
  expects_output: false,
  retain_receipt: true,
  run: ({db}) => {
    const verification = db.transaction(() => inspectWorldIntegrity(db)).deferred();
    return { status: verification.ok ? "ok" : "failed", errors: verification.checks
      .filter(check => check.status === "FAIL").map(check => `world-verify:${check.id}`) };
  },
});
