export interface HotSnapshotBuildContext<T> {
  prev: T | null;
  fingerprint: string | null;
}

export interface HotSnapshotOptions<T> {
  name: string;
  build: (ctx: HotSnapshotBuildContext<T>) => Promise<T> | T;
  fingerprint?: () => Promise<string> | string;
  checkIntervalMs?: number;
  maxAgeMs?: number;
  autoStart?: boolean;
  onError?: (err: unknown) => void;
}

export interface HotSnapshotRefreshOptions {
  force?: boolean;
}

export interface HotSnapshotMarkDirtyOptions {
  forceRebuild?: boolean;
  triggerNow?: boolean;
}

/**
 * Reusable stale-while-revalidate snapshot store with single-flight refresh,
 * fingerprint gating, non-destructive markDirty(), monotonic version counter,
 * and clean timer disposal.
 */
export class HotSnapshot<T> {
  readonly name: string;

  private readonly buildFn: (ctx: HotSnapshotBuildContext<T>) => Promise<T> | T;
  private readonly fingerprintFn?: () => Promise<string> | string;
  private readonly checkIntervalMs: number;
  private readonly maxAgeMs: number;
  private readonly onError?: (err: unknown) => void;

  private value: T | null = null;
  private lastFingerprint: string | null = null;
  private lastBuiltAt = 0;
  private lastCheckedAt = 0;
  private currentVersion = 0;

  private inFlight: Promise<T> | null = null;
  private dirty = false;
  private forceNext = false;
  private pendingRecheck = false;
  private pendingForce = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: HotSnapshotOptions<T>) {
    this.name = opts.name;
    this.buildFn = opts.build;
    this.fingerprintFn = opts.fingerprint;
    this.checkIntervalMs = Math.max(0, Number(opts.checkIntervalMs ?? 0) || 0);
    this.maxAgeMs = Math.max(0, Number(opts.maxAgeMs ?? 0) || 0);
    this.onError = opts.onError;

    if (opts.autoStart && this.checkIntervalMs > 0) {
      this.start();
    }
  }

  get version(): number {
    return this.currentVersion;
  }

  get builtAt(): number {
    return this.lastBuiltAt;
  }

  staleMs(now = Date.now()): number {
    if (this.lastBuiltAt <= 0) return 0;
    return Math.max(0, now - this.lastBuiltAt);
  }

  hasValue(): boolean {
    return this.value !== null;
  }

  peek(): T | null {
    return this.value;
  }

  isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  start(): void {
    if (this.disposed || this.timer !== null || this.checkIntervalMs <= 0) return;
    const handle = setInterval(() => {
      if (this.disposed) return;
      if (this.value === null && this.inFlight === null) return;
      void this.refresh({ force: false }).catch(() => {
        // Background errors are reported via onError and never crash the loop.
      });
    }, this.checkIntervalMs);
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    this.timer = handle;
  }

  /**
   * Stale-while-revalidate read:
   * - Cold boot (no snapshot yet): awaits single-flight initial build.
   * - Warm (snapshot present): returns cached pointer immediately (<1ms),
   *   and schedules a background refresh if dirty or past maxAgeMs (without fingerprint).
   */
  async get(): Promise<T> {
    if (!this.disposed && this.checkIntervalMs > 0 && this.timer === null) {
      this.start();
    }

    if (this.value !== null) {
      const shouldBackgroundRefresh =
        this.dirty ||
        (!this.fingerprintFn &&
          this.maxAgeMs > 0 &&
          Date.now() - this.lastBuiltAt >= this.maxAgeMs);

      if (shouldBackgroundRefresh && !this.disposed) {
        void this.refresh({ force: this.forceNext }).catch(() => {
          // Keep serving last good snapshot on background refresh error.
        });
      }
      return this.value;
    }

    return this.refresh({ force: true });
  }

  /**
   * Synchronous read for sync APIs (e.g. KizukiReplayApi).
   * - Warm: returns cached pointer synchronously and triggers background refresh when dirty.
   * - Cold: builds synchronously once, stores pointer + fingerprint, and starts interval gate.
   */
  getSync(syncBuild: () => T, syncFingerprint?: () => string): T {
    if (!this.disposed && this.checkIntervalMs > 0 && this.timer === null) {
      this.start();
    }

    if (this.value !== null) {
      if (this.dirty && !this.disposed && !this.inFlight) {
        this.scheduleBackgroundRefresh(this.forceNext);
      }
      return this.value;
    }

    const fp = syncFingerprint ? syncFingerprint() : null;
    const built = syncBuild();
    this.value = built;
    this.lastFingerprint = fp;
    const now = Date.now();
    this.lastBuiltAt = now;
    this.lastCheckedAt = now;
    this.currentVersion += 1;
    this.dirty = false;
    this.forceNext = false;
    return built;
  }

  /**
   * Single-flight refresh with fingerprint gate.
   * Skips calling build() when fingerprint matches the last built snapshot unless forced.
   */
  refresh(opts: HotSnapshotRefreshOptions = {}): Promise<T> {
    if (this.disposed) {
      if (this.value !== null) return Promise.resolve(this.value);
      return Promise.reject(new Error(`HotSnapshot "${this.name}" is disposed`));
    }

    const force = Boolean(opts.force || this.forceNext);

    if (this.inFlight) {
      if (force || this.dirty) {
        this.pendingRecheck = true;
        if (force) this.pendingForce = true;
      }
      return this.inFlight;
    }

    const run = async (): Promise<T> => {
      let fp: string | null = null;
      if (this.fingerprintFn) {
        try {
          fp = await this.fingerprintFn();
        } catch (err) {
          this.onError?.(err);
          fp = null;
        }
      }

      const now = Date.now();
      this.lastCheckedAt = now;

      if (
        !force &&
        this.value !== null &&
        this.fingerprintFn &&
        fp !== null &&
        this.lastFingerprint !== null &&
        fp === this.lastFingerprint
      ) {
        this.dirty = false;
        this.forceNext = false;
        return this.value;
      }

      if (
        !force &&
        !this.dirty &&
        !this.fingerprintFn &&
        this.value !== null &&
        this.maxAgeMs > 0 &&
        now - this.lastBuiltAt < this.maxAgeMs
      ) {
        return this.value;
      }

      try {
        const next = await this.buildFn({ prev: this.value, fingerprint: fp });
        if (!this.disposed) {
          this.value = next;
          if (fp !== null) {
            this.lastFingerprint = fp;
          } else if (this.fingerprintFn) {
            try {
              this.lastFingerprint = await this.fingerprintFn();
            } catch {
              // keep previous fingerprint if post-build probe fails
            }
          }
          this.lastBuiltAt = Date.now();
          this.currentVersion += 1;
          this.dirty = false;
          this.forceNext = false;
        }
        return next;
      } catch (err) {
        this.onError?.(err);
        this.dirty = false;
        this.forceNext = false;
        if (this.value !== null) {
          return this.value;
        }
        throw err;
      }
    };

    const promise = run().finally(() => {
      this.inFlight = null;
      if (this.pendingRecheck && !this.disposed) {
        const nextForce = this.pendingForce;
        this.pendingRecheck = false;
        this.pendingForce = false;
        this.scheduleBackgroundRefresh(nextForce);
      }
    });

    this.inFlight = promise;
    return promise;
  }

  /**
   * Marks the snapshot dirty and triggers a background refresh without ever
   * clearing or blocking access to the last good cached snapshot.
   */
  markDirty(opts: HotSnapshotMarkDirtyOptions = {}): void {
    if (this.disposed) return;
    const forceRebuild = opts.forceRebuild !== false;
    const triggerNow = opts.triggerNow !== false;

    this.dirty = true;
    if (forceRebuild) {
      this.forceNext = true;
    }

    if (!triggerNow) return;

    if (this.inFlight) {
      this.pendingRecheck = true;
      if (forceRebuild) this.pendingForce = true;
      return;
    }

    // Only kick off background work if we already have a warm snapshot or explicitly requested.
    if (this.value !== null) {
      this.scheduleBackgroundRefresh(forceRebuild);
    }
  }

  /**
   * Hard reset (for explicit test/import cache clear). Keeps version monotonic.
   */
  clear(): void {
    this.value = null;
    this.lastFingerprint = null;
    this.lastBuiltAt = 0;
    this.lastCheckedAt = 0;
    this.dirty = false;
    this.forceNext = false;
    this.pendingRecheck = false;
    this.pendingForce = false;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingRecheck = false;
    this.pendingForce = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scheduleBackgroundRefresh(force: boolean): void {
    if (this.disposed) return;
    const t = setTimeout(() => {
      if (this.disposed) return;
      void this.refresh({ force }).catch(() => {
        // Background errors preserve last good snapshot.
      });
    }, 0);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  }
}
