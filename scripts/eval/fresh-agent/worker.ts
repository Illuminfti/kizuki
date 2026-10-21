import { installLogicalClock } from "./clock";
import { installFixtureEntropy } from "./entropy";
import { AS_OF } from "./persona";
import type { PersonaSize } from "./persona";

// Control time and identifiers before loading Core/CLI. Both overrides stay
// inside this synthetic worker; timers retain their real deadlines.
installLogicalClock(AS_OF);
installFixtureEntropy();
try {
  const options = JSON.parse(process.argv[2]!) as { size?: PersonaSize; out: string };
  const { evaluateAtLogicalTime } = await import("./run");
  await evaluateAtLogicalTime(options);
  // Session hooks leave deadline timers pending after successful reads.
  process.exit(0);
} catch {
  console.error("Fresh-agent worker failed.");
  process.exit(1);
}
