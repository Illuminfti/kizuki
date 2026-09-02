import { existsSync, readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { sha256Bytes } from "./atomic";

export type WatchEventType = "change" | "rename";

export interface WatchEvent {
  readonly type: WatchEventType;
  readonly path: string;
}

export interface RefreshWatcherOptions {
  readonly root: string;
  readonly refresh: () => Promise<void>;
  readonly isSelfWrite: (path: string, digest: string) => boolean;
}

export class RefreshWatcher {
  private dirty = false;
  private inFlight = false;
  private closed = false;
  private watcher: FSWatcher | undefined;
  refreshPasses = 0;
  detectedRenames: string[] = [];
  ignoredSelfWrites = 0;

  constructor(private readonly options: RefreshWatcherOptions) {}

  start(): void {
    if (this.watcher !== undefined) return;
    this.watcher = watch(
      this.options.root,
      { persistent: false },
      (event, filename) => {
        const name = filename?.toString() ?? "";
        const path = name.length === 0 ? this.options.root : resolve(this.options.root, name);
        void this.handle({
          type: event === "rename" ? "rename" : "change",
          path,
        });
      },
    );
  }

  async handle(event: WatchEvent): Promise<void> {
    if (this.closed) return;
    if (event.type === "rename") {
      this.detectedRenames.push(event.path);
    }
    if (this.shouldIgnore(event.path)) {
      this.ignoredSelfWrites += 1;
      return;
    }
    this.dirty = true;
    if (this.inFlight) return;
    await this.drain();
  }

  async idle(): Promise<void> {
    while (this.inFlight || this.dirty) {
      await this.drain();
    }
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private shouldIgnore(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const digest = sha256Bytes(readFileSync(path));
      return this.options.isSelfWrite(path, digest);
    } catch {
      return false;
    }
  }

  private async drain(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        this.refreshPasses += 1;
        await this.options.refresh();
      }
    } finally {
      this.inFlight = false;
    }
  }
}
