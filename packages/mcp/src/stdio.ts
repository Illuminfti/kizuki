import { TOOLS } from "@kizuki/core";
import type { ServeContext } from "@kizuki/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

function isRequest(message: object): boolean {
  return "method" in message && "id" in message;
}

function isAnswer(message: object): boolean {
  return "id" in message && !("method" in message);
}

/** Resolves once the pipe has taken everything already handed to it. */
async function drained(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
}

/**
 * stdout is the protocol channel and nothing else writes to it. The one
 * readiness line goes to stderr, where a harness can see it without
 * corrupting the stream.
 */
export async function runStdio(ctx: ServeContext): Promise<void> {
  const server = createServer(ctx);
  const transport = new StdioServerTransport();

  // A client that writes its last request and closes the pipe in the same
  // turn is the normal case, not an edge one. Counting requests against the
  // answers the transport has sent is what makes the shutdown wait for the
  // work rather than for a fixed number of turns.
  let inFlight = 0;
  let ended = false;
  let close: (() => void) | null = null;
  const settle = (): void => {
    if (!ended || inFlight > 0 || close === null) return;
    const stop = close;
    close = null;
    stop();
  };

  const deliver = transport.onmessage?.bind(transport);
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    try {
      await send(message);
    } finally {
      // A write that fails still ends the request it was answering; leaving
      // the count up would wedge the shutdown on work that cannot finish.
      if (isAnswer(message)) {
        inFlight -= 1;
        settle();
      }
    }
  };

  await server.connect(transport);

  const handle = transport.onmessage?.bind(transport) ?? deliver;
  transport.onmessage = (message) => {
    if (isRequest(message)) inFlight += 1;
    handle?.(message);
  };

  const name =
    ctx.principal.kind === "owner" ? "owner" : ctx.principal.agent.name;
  process.stderr.write(
    `kizuki-mcp ready principal=${name} tools=${TOOLS.length}\n`,
  );

  // The transport's own onclose belongs to the SDK; the low-level server
  // reports the close that ends this process. The transport listens for data
  // and errors but not for end of input, so a harness closing the pipe has to
  // be turned into a close here or the process would outlive its client.
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    close = () => {
      void drained().then(() => server.close());
    };
    process.stdin.once("end", () => {
      ended = true;
      settle();
    });
  });
}
