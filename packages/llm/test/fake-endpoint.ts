export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type FakeReply = (
  request: SeenRequest,
) => Response | Promise<Response>;

export interface FakeEndpoint {
  readonly base_url: string;
  readonly origin: string;
  readonly requests: SeenRequest[];
  reply: FakeReply;
  stop(): void;
}

const DEFAULT_CONTENT = "Grace runs partnerships at Acme.";

export function defaultChatCompletion(content = DEFAULT_CONTENT): Response {
  return Response.json({
    id: "cmpl-synthetic",
    object: "chat.completion",
    created: 1,
    model: "synthetic",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  });
}

function headerMap(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

export function startFakeEndpoint(reply?: FakeReply): FakeEndpoint {
  const requests: SeenRequest[] = [];
  let currentReply: FakeReply = reply ?? (() => defaultChatCompletion());

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: unknown = null;
      const text = await request.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      const seen: SeenRequest = {
        method: request.method,
        path: url.pathname,
        headers: headerMap(request.headers),
        body,
      };
      requests.push(seen);
      return currentReply(seen);
    },
  });

  if (server.hostname !== "127.0.0.1") {
    server.stop(true);
    throw new Error("fake endpoint refused a non-loopback bind");
  }

  return {
    base_url: `http://127.0.0.1:${server.port}/v1`,
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    get reply() {
      return currentReply;
    },
    set reply(next: FakeReply) {
      currentReply = next;
    },
    stop() {
      server.stop(true);
    },
  };
}
