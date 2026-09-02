import { TOOLS } from "@kizuki/core";
import type { ServeContext } from "@kizuki/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

/**
 * stdout is the protocol channel and nothing else writes to it. The one
 * readiness line goes to stderr, where a harness can see it without
 * corrupting the stream.
 */
export async function runStdio(ctx: ServeContext): Promise<void> {
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

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
    process.stdin.once("end", () => {
      // One turn later, so a response already dispatched for the last request
      // is written before the stream goes away.
      setImmediate(() => {
        void server.close();
      });
    });
  });
}
