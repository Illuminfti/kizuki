export interface FakeReply {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /** Streams this many bytes with no content-length, in 64 KiB chunks. */
  stream_bytes?: number;
  delay_ms?: number;
}

export interface FakeEndpoint {
  url: string;
  requests: { headers: Record<string, string>; body: unknown }[];
  stop(): Promise<void>;
}

/** A chat completion the strict reader accepts. */
export function chatCompletion(content: string, model = "m"): unknown {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

/**
 * A loopback stand-in for a model endpoint. It binds an ephemeral port on
 * 127.0.0.1 so no test needs a real provider, and it records what it was
 * sent so a test can prove what did and did not leave the process.
 */
export function startFakeEndpoint(
  replies: FakeReply[] | ((count: number) => FakeReply),
): FakeEndpoint {
  const requests: FakeEndpoint["requests"] = [];
  let count = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      requests.push({ headers, body });

      const reply = Array.isArray(replies)
        ? (replies[Math.min(count, replies.length - 1)] ?? {})
        : replies(count);
      count += 1;
      if (reply.delay_ms !== undefined) await Bun.sleep(reply.delay_ms);

      if (reply.stream_bytes !== undefined) {
        const total = reply.stream_bytes;
        const chunk = new Uint8Array(65_536).fill(120);
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= total) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
            sent += chunk.byteLength;
          },
        });
        return new Response(stream, {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }

      const text =
        reply.raw ?? JSON.stringify(reply.body ?? chatCompletion("{}"));
      return new Response(text, {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}
