import { installLogicalClock } from "./clock";
import { AS_OF } from "./persona";
import type { PersonaSize } from "./persona";

// Core also uses Date directly. Freeze it before any Core/CLI module is loaded;
// timers keep their real deadlines and the caller's clock is never changed.
installLogicalClock(AS_OF);
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
