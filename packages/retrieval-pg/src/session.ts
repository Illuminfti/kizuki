import type { PortContext, RetrievalPort } from "@kizuki/core";
import { openEmbeddedRetrievalPort } from "./port";
import type { EmbeddedRetrievalOptions } from "./port";
/** One pending open as well as one ready connection per surface lifetime. */
export class McpEngineSurface {
  private opening: Promise<RetrievalPort> | undefined;
  engineOpens = 0;
  open(ctx: PortContext, options: EmbeddedRetrievalOptions = {}): Promise<RetrievalPort> {
    if (this.opening !== undefined) {
      return this.opening;
    }
    this.engineOpens += 1;
    this.opening = openEmbeddedRetrievalPort(ctx, options).catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  async invoke<T>(ctx: PortContext, options: EmbeddedRetrievalOptions, operation: (port: RetrievalPort) => Promise<T>): Promise<T> {
    return operation(await this.open(ctx, options));
  }
  async close(): Promise<void> {
    const opening = this.opening;
    if (opening !== undefined) {
      try {
        await (await opening).close();
      }
      finally {
        if (this.opening === opening) {
          this.opening = undefined;
        }
      }
    }
  }
}
