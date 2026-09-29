import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk, PortContext } from "@kizuki/core";

export const FIXED_NOW = "2026-09-02T12:00:00.000Z";
export const DIMS = 8;

export interface RecordedRequest {
  readonly path: string;
  readonly body: { model: string; input: string[]; [key: string]: unknown };
}

export type Behaviour =
  | { kind: "ok" }
  | { kind: "delay"; ms: number }
  | { kind: "status"; status: number }
  | { kind: "redirect" }
  | { kind: "garbage" }
  | { kind: "width"; dims: number }
  | { kind: "short" }
  | { kind: "null-value" }
  | { kind: "shuffle" }
  | { kind: "huge" };

/** Deterministic vector so equal inputs match and different inputs differ. */
export function hashVector(text: string, dims = DIMS): number[] {
  const vector = new Array<number>(dims).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (let at = 0; at < token.length; at += 1)
      hash = (hash * 33 + token.charCodeAt(at)) >>> 0;
    vector[hash % dims] = (vector[hash % dims] ?? 0) + 1;
  }
  return vector;
}

export interface FakeServer {
  port: number;
  readonly requests: RecordedRequest[];
  behaviour: Behaviour;
  embed: (text: string) => number[];
  stop(): void;
}

/** A stand-in embedding server bound to 127.0.0.1 that speaks both wire formats. */
export function startFakeServer(): FakeServer {
  const requests: RecordedRequest[] = [];
  const state: FakeServer = {
    port: 0,
    requests,
    behaviour: { kind: "ok" },
    embed: (text) => hashVector(text),
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as RecordedRequest["body"];
      requests.push({ path, body });
      const behaviour = state.behaviour;
      if (behaviour.kind === "delay") await Bun.sleep(behaviour.ms);
      if (behaviour.kind === "status")
        return new Response("nope", { status: behaviour.status });
      if (behaviour.kind === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:9/elsewhere" },
        });
      if (behaviour.kind === "garbage")
        return new Response("not json at all", {
          headers: { "content-type": "application/json" },
        });
      if (behaviour.kind === "huge") {
        return new Response(
          new Blob([new Uint8Array(17 * 1024 * 1024).fill(32)]),
          { headers: { "content-type": "application/json" } },
        );
      }
      let vectors = body.input.map((text) => state.embed(text));
      if (behaviour.kind === "width")
        vectors = vectors.map((vector) => vector.slice(0, behaviour.dims));
      if (behaviour.kind === "short") vectors = vectors.slice(1);
      if (behaviour.kind === "null-value")
        vectors = vectors.map((vector) => [
          null as unknown as number,
          ...vector.slice(1),
        ]);
      if (path === "/api/embed")
        return Response.json({ model: body.model, embeddings: vectors });
      if (path === "/v1/embeddings") {
        const data = vectors.map((embedding, index) => ({
          object: "embedding",
          index,
          embedding,
        }));
        return Response.json({
          object: "list",
          model: body.model,
          data: behaviour.kind === "shuffle" ? data.reverse() : data,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.port = server.port ?? 0;
  return state;
}

export interface TemporaryEmbed {
  readonly root: string;
  readonly ctx: PortContext;
  cleanup(): void;
}

export function temporaryEmbed(
  config: Record<string, unknown>,
): TemporaryEmbed {
  const root = mkdtempSync(join(tmpdir(), "kizuki-embed-local-http-"));
  const vault = join(root, "vault");
  const dataDir = join(
    vault,
    ".kizuki",
    "embedding",
    "kizuki.embedding.local-http",
  );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ctx: {
      vault_path: vault,
      data_dir: dataDir,
      config: Object.freeze({ ...config }),
      secrets: async () => {
        throw new Error("embed-local-http tests do not resolve secrets");
      },
      clock: () => FIXED_NOW,
      logger: () => {},
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function configFor(
  port: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    api: "openai",
    endpoint: `http://127.0.0.1:${port}`,
    model: "Synthetic-Embed:v1",
    dims: DIMS,
    max_input_tokens: 512,
    timeout_ms: 2_000,
    ...overrides,
  };
}

export function fixtureChunks(): Chunk[] {
  return [
    {
      chunk_id: "chunk:grace-0",
      doc_id: "page:grace",
      title: "Grace at Acme",
      text: "Grace runs partnerships at Acme.",
      index: 0,
    },
    {
      chunk_id: "chunk:grace-1",
      doc_id: "page:grace",
      title: "Grace at Acme",
      text: "Grace can be reached at grace@acme.test.",
      index: 1,
    },
  ];
}
