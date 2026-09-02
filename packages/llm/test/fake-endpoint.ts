export interface SeenRequest {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeEndpoint {
  base_url: string;
  requests: SeenRequest[];
  stop: () => void;
}

export interface FakeEndpointOptions {
  reply?: (seen: SeenRequest) => Response | Promise<Response>;
}

interface WrappedRecord {
  producer?: unknown;
  record?: { text?: unknown; connector_id?: unknown; subjects?: unknown };
}

function wrapped(body: unknown): WrappedRecord {
  if (typeof body !== "object" || body === null) return {};
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return {};
  const user = messages[1] as { content?: unknown } | undefined;
  if (typeof user?.content !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(user.content);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as WrappedRecord)
      : {};
  } catch {
    return {};
  }
}

/**
 * A reply the validators accept, shaped for whichever producer asked. Tests
 * that need a hostile or malformed answer pass their own `reply`.
 */
function defaultContent(seen: SeenRequest): string {
  const { producer, record } = wrapped(seen.body);
  const text = typeof record?.text === "string" ? record.text : "";
  if (producer === "entities") {
    return JSON.stringify({
      entities: [
        {
          name: "acme",
          type: "org",
          aliases: [],
          evidence: text.slice(0, 60),
          confidence: 0.6,
        },
      ],
    });
  }
  if (producer === "claims") {
    return JSON.stringify({
      claims: [
        { statement: "acme runs the library.", subject_id: null, confidence: 0.7 },
      ],
    });
  }
  return JSON.stringify({
    title: "A captured record",
    summary: text.slice(0, 200),
    confidence: 0.8,
  });
}

export function chatCompletion(content: string, model = "fake-model"): Response {
  return Response.json({
    id: "cmpl-fake",
    model,
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });
}

/**
 * Binds loopback on an ephemeral port so a test can exercise the real
 * transport without leaving the machine. Never used by product code.
 */
export function startFakeEndpoint(opts: FakeEndpointOptions = {}): FakeEndpoint {
  const requests: SeenRequest[] = [];
  const reply = opts.reply;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const text = await request.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // A test may post something that is not JSON; keep the raw text.
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const seen: SeenRequest = {
        path: new URL(request.url).pathname,
        headers,
        body,
      };
      requests.push(seen);
      return reply === undefined
        ? chatCompletion(defaultContent(seen))
        : await reply(seen);
    },
  });
  if (server.hostname !== "127.0.0.1") {
    server.stop(true);
    throw new Error(`fake endpoint bound ${String(server.hostname)}`);
  }
  return {
    base_url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => {
      server.stop(true);
    },
  };
}
