import { appendFileSync } from "node:fs";

const log = process.env.KIZUKI_WEBSOCKET_LOG;

globalThis.WebSocket = class {
  constructor(url: string | URL) {
    if (typeof log === "string" && log.length > 0) {
      appendFileSync(log, `${String(url)}\n`);
    }
    throw new Error("runtime websocket forbidden");
  }
} as typeof WebSocket;
