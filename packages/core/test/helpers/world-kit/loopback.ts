/**
 * The one loopback HTTP helper for world tests. It starts the standing serve
 * endpoint on 127.0.0.1 and is the only place the world test kit calls
 * `fetch`; later workstreams reuse it instead of adding call sites.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { startServeHttp } from "../../../src/serve/http";

export interface LoopbackReply {
  readonly status: number;
  readonly body: unknown;
}

export interface Loopback {
  readonly url: string;
  /** Bearer that authenticates as the owner. Agents present their own token. */
  readonly ownerToken: string;
  /** POST a tool call. `bearer` defaults to the owner token. */
  post(tool: string, args: Record<string, unknown>, bearer?: string): Promise<LoopbackReply>;
  stop(): Promise<void>;
}

export async function startLoopback(db: Database, vaultPath: string): Promise<Loopback> {
  const handle = startServeHttp({ db, vaultPath, host: "127.0.0.1" });
  const ownerToken = readFileSync(handle.tokenPath, "utf8").trim();
  return {
    url: handle.url,
    ownerToken,
    async post(tool, args, bearer = ownerToken) {
      const response = await fetch(`${handle.url}/v1/${tool}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      return { status: response.status, body: await response.json() };
    },
    stop: () => handle.stop(),
  };
}
