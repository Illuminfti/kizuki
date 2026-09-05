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
    let obtainedPort = false;
    this.closing = (async () => {
      const port = await opening;
      obtainedPort = true;
      await port.close();
      if (this.opening === opening) this.opening = undefined;
    })().then(
      () => { this.closing = undefined; },
      error => {
        // Opening already unwound without producing a connection. Its failure
        // must not poison retry; a failed close of an actual port stays blocked.
        if (!obtainedPort) this.closing = undefined;
        throw error;
      },
    );
    return this.closing;
  }
}
