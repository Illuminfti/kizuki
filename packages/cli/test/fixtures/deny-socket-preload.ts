import { appendFileSync } from "node:fs";

const log = process.env.KIZUKI_CONNECT_LOG;

Bun.connect = ((input: Parameters<typeof Bun.connect>[0]) => {
  if (typeof log === "string" && log.length > 0) {
    const rec = input as { hostname?: unknown; port?: unknown };
    const target = typeof rec.hostname === "string"
      ? `${rec.hostname}:${String(rec.port ?? "")}`
      : String(input);
    appendFileSync(log, `${target}\n`);
  }
  return Promise.reject(new Error("runtime connect forbidden"));
}) as typeof Bun.connect;
