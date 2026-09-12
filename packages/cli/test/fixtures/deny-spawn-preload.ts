import { appendFileSync } from "node:fs";

const log = process.env.KIZUKI_SPAWN_LOG;

function targetOf(input: unknown): string {
  if (Array.isArray(input) && typeof input[0] === "string") return input[0];
  if (input !== null && typeof input === "object" && "cmd" in input) {
    const cmd = (input as { cmd?: unknown }).cmd;
    if (Array.isArray(cmd) && typeof cmd[0] === "string") return cmd[0];
  }
  return String(input);
}

function record(input: unknown): void {
  if (typeof log === "string" && log.length > 0) {
    appendFileSync(log, `${targetOf(input)}\n`);
  }
}

Bun.spawn = ((input: unknown) => {
  record(input);
  throw new Error("runtime spawn forbidden");
}) as unknown as typeof Bun.spawn;

Bun.spawnSync = ((input: unknown) => {
  record(input);
  throw new Error("runtime spawn forbidden");
}) as unknown as typeof Bun.spawnSync;
