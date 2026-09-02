import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeRemoteValue,
  encodeRemoteValue,
  remoteDescribePath,
  remoteMethodPrefix,
} from "../../src/contracts/remote";
import { PortError } from "../../src/contracts/ports";
import type { PortContext, PortDescriptor } from "../../src/contracts/ports";
import type { RetrievalPort } from "../../src/contracts/retrieval";
import { FIXED_NOW } from "./fixtures";
import {
  DIRECT_RETRIEVAL_DESCRIPTOR,
  ReferenceRetrievalPort,
} from "./reference-retrieval";

const [socketPath, readyPath, stateDir, token] = Bun.argv.slice(2);
if (
  socketPath === undefined ||
  readyPath === undefined ||
  stateDir === undefined ||
  token === undefined
) {
  throw new Error("remote fixture requires socket, ready, state, and token");
}

const descriptor = {
  ...DIRECT_RETRIEVAL_DESCRIPTOR,
  method_timeouts_ms: { wait: 10 },
} satisfies PortDescriptor;

const context: PortContext = {
  vault_path: stateDir,
  data_dir: stateDir,
  config: {},
  secrets: async () => token,
  clock: () => FIXED_NOW,
  logger: () => {},
};
const port: RetrievalPort = new ReferenceRetrievalPort(context, descriptor);

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value =
      typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    bytes += value.byteLength;
    if (bytes > 1_000_000) {
      throw new PortError(
        "config_invalid",
        "remote fixture request exceeds its size limit",
        false,
      );
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "upsert":
      return port.upsert(args[0] as Parameters<RetrievalPort["upsert"]>[0]);
    case "search":
      return port.search(args[0] as Parameters<RetrievalPort["search"]>[0]);
    case "remove":
      return port.remove(args[0] as Parameters<RetrievalPort["remove"]>[0]);
    case "verifyAbsent":
      return port.verifyAbsent(
        args[0] as Parameters<RetrievalPort["verifyAbsent"]>[0],
      );
    case "neighbors":
      return port.neighbors(
        args[0] as Parameters<RetrievalPort["neighbors"]>[0],
        args[1] as Parameters<RetrievalPort["neighbors"]>[1],
      );
    case "health":
      return port.health();
    case "echo":
      return args[0];
    case "wait":
      await Bun.sleep(args[0] as number);
      return "finished";
    default:
      throw new PortError(
        "not_supported",
        `remote fixture does not support ${method}`,
        false,
      );
  }
}

const describePath = remoteDescribePath(descriptor.contract);
const methodPrefix = remoteMethodPrefix(descriptor.contract);
const server = createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, {
        ok: false,
        error: {
          code: "unavailable",
          message: "authorization required",
          retryable: false,
        },
      });
      return;
    }

    if (request.method === "GET" && request.url === describePath) {
      json(response, 200, { ok: true, value: descriptor });
      return;
    }
    if (
      request.method !== "POST" ||
      request.url === undefined ||
      !request.url.startsWith(methodPrefix)
    ) {
      json(response, 404, {
        ok: false,
        error: {
          code: "not_supported",
          message: "unknown remote fixture route",
          retryable: false,
        },
      });
      return;
    }

    const method = decodeURIComponent(request.url.slice(methodPrefix.length));
    const body = decodeRemoteValue(await bodyOf(request));
    if (
      typeof body !== "object" ||
      body === null ||
      !("args" in body) ||
      !Array.isArray(body.args)
    ) {
      throw new PortError(
        "config_invalid",
        "remote fixture expected an args array",
        false,
      );
    }
    const value = await invoke(method, body.args);
    json(response, 200, encodeRemoteValue({ ok: true, value }));
  } catch (error) {
    const portError =
      error instanceof PortError
        ? error
        : new PortError(
            "unavailable",
            "remote fixture method failed",
            true,
          );
    json(response, 200, {
      ok: false,
      error: {
        code: portError.code,
        message: portError.message,
        retryable: portError.retryable,
      },
    });
  }
});

server.listen(socketPath, () => {
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
});

async function shutdown(): Promise<void> {
  await port.close();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
