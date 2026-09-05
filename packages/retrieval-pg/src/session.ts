import type { PortContext, RetrievalPort } from "@kizuki/core";
import { openEmbeddedRetrievalPort } from "./port";
import type { EmbeddedRetrievalOptions } from "./port";
/** One pending open as well as one ready connection per surface lifetime. */
export class McpEngineSurface {
  private opening: Promise<RetrievalPort> | undefined;
  private closing: Promise<void> | undefined;
  engineOpens = 0;
  open(ctx: PortContext, options: EmbeddedRetrievalOptions = {}): Promise<RetrievalPort> {
    if (this.closing !== undefined) return this.closing.then(() => this.open(ctx, options));
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
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const opening = this.opening;
    if (opening === undefined) return Promise.resolve();
    this.closing = (async () => {
      await (await opening).close();
      if (this.opening === opening) this.opening = undefined;
    })().then(() => { this.closing = undefined; });
    // A failed close stays failed/closing; never open another engine beside it.
    return this.closing;
  }
}
