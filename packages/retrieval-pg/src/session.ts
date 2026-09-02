import type { PortContext, RetrievalPort } from "@kizuki/core";
import { createEmbeddedRetrievalPort } from "./port";
import type { EmbeddedRetrievalOptions } from "./port";

/**
 * MCP and other long-lived surfaces hold one engine connection for the
 * process lifetime. Opening per tool call is forbidden.
 */
export class McpEngineSurface {
  private port: RetrievalPort | undefined;
  engineOpens = 0;

  async open(
    ctx: PortContext,
    options: EmbeddedRetrievalOptions = {},
  ): Promise<RetrievalPort> {
    if (this.port !== undefined) return this.port;
    this.engineOpens += 1;
    this.port = createEmbeddedRetrievalPort(ctx, options);
    return this.port;
  }

  async invoke<T>(
    ctx: PortContext,
    options: EmbeddedRetrievalOptions,
    operation: (port: RetrievalPort) => Promise<T>,
  ): Promise<T> {
    const port = await this.open(ctx, options);
    return operation(port);
  }

  async close(): Promise<void> {
    await this.port?.close();
    this.port = undefined;
  }
}
