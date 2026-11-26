import { on } from "node:events";
import { isMainThread, type MessagePort, workerData } from "node:worker_threads";

export type Request = { method: "query"; sql: string; params?: unknown[] } | { method: "exec"; sql: string } |
  { method: "close"; disposeAssets: boolean };
export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false };
export const EMBEDDED_SQL_WORKER = "kizuki.embedded-sql/v1";

async function serveDatabase(dataDir: string, channel: MessagePort): Promise<void> {
  const messages = on(channel, "message");
  const { openDatabase } = await import("./assets");
  const resource = await openDatabase(dataDir);
  for await (const [message] of messages) {
    const { id, request } = message as { id: number; request: Request };
    try {
      if (request.method === "close") {
        await resource.db.close();
        if (request.disposeAssets) resource.dispose();
        channel.postMessage({ id, ok: true });
        return;
      }
      const result = request.method === "query"
        ? await resource.db.query(request.sql, request.params)
        : await resource.db.exec(request.sql);
      channel.postMessage({ id, ok: true, result });
    } catch {
      // Provider errors can contain captured values. Return only the refusal.
      channel.postMessage({ id, ok: false });
    }
  }
}

// In a compiled executable import.meta.url is the bundled entrypoint. Finish
// the private worker here before the ordinary CLI entrypoint can run.
if (!isMainThread && workerData?.kind === EMBEDDED_SQL_WORKER) {
  try { await serveDatabase(workerData.directory, workerData.channel); process.exit(0); }
  catch { process.exit(1); }
}
