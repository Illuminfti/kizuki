import { MessageChannel, Worker } from "node:worker_threads";
import type { Results } from "@electric-sql/pglite";
import { PortError } from "@kizuki/core";
import { EMBEDDED_SQL_WORKER, type Request, type Reply } from "./worker-entry";

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Results<T>>;
  exec(sql: string): Promise<Results[]>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(disposeAssets?: boolean): Promise<void>;
}

/** Only the daemon uses a worker. Synchronous WASM and disk IO cannot stall its HTTP listener. */
export function openWorkerDatabase(directory: string): SqlDatabase {
  const { port1: channel, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: EMBEDDED_SQL_WORKER, directory, channel: port2 }, transferList: [port2],
  });
  let next = 0;
  let stopped = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const unavailable = () => new PortError("unavailable", "embedded SQL worker is unavailable", false);
  const stop = () => {
    stopped = true;
    channel.close();
    for (const call of pending.values()) call.reject(unavailable());
    pending.clear();
  };
  worker.on("error", stop);
  worker.on("exit", stop);
  channel.on("message", (reply: Reply) => {
    const call = pending.get(reply.id);
    if (call === undefined) return;
    pending.delete(reply.id);
    if (reply.ok) call.resolve(reply.result);
    else call.reject(unavailable());
  });
  function call<T>(request: Request): Promise<T> {
    if (stopped) return Promise.reject(unavailable());
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as T), reject });
      try { channel.postMessage({ id, request }); }
      catch { pending.delete(id); reject(unavailable()); }
    });
  }
  const sql: SqlExecutor = {
    query: (sql, params) => call({ method: "query", sql, ...(params === undefined ? {} : { params }) }),
    exec: sql => call({ method: "exec", sql }),
  };
  return {
    ...sql,
    // SqlStore holds its FIFO across the callback, including the final commit.
    async transaction(work) {
      await sql.exec("BEGIN");
      try { const result = await work(sql); await sql.exec("COMMIT"); return result; }
      catch (error) { await sql.exec("ROLLBACK"); throw error; }
    },
    async close(disposeAssets = true) {
      try { if (!stopped) await call({ method: "close", disposeAssets }); }
      finally { await worker.terminate(); }
    },
  };
}
