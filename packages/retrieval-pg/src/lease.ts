import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { PortError, isPlainObject, isRfc3339 } from "@kizuki/core";
import { ensureDir, writeAtomic } from "./atomic";
import {
  LEASE_HELD_REL,
  LEASE_HOLDER_REL,
  LEASE_QUEUE_REL,
  LEASE_RECEIPTS_REL,
  dataPath,
} from "./paths";

export const DEFAULT_HEARTBEAT_MS = 200;
export const STALE_HEARTBEAT_MULTIPLIER = 3;

export interface LeaseHolder {
  readonly pid: number;
  readonly holder_id: string;
  readonly heartbeat_at: string;
  readonly acquired_at: string;
}

export interface LeaseReceipt {
  readonly action: "acquired" | "reclaimed" | "released";
  readonly previous: LeaseHolder | null;
  readonly holder: LeaseHolder | null;
  readonly at: string;
}

export interface LeaseSnapshot {
  readonly holder: LeaseHolder | null;
  readonly queue_depth: number;
  readonly live: boolean;
  readonly stale: boolean;
}

interface QueueState {
  waiters: string[];
}

function parseHolder(value: unknown): LeaseHolder | null {
  if (
    !isPlainObject(value) ||
    typeof value["pid"] !== "number" ||
    !Number.isSafeInteger(value["pid"]) ||
    value["pid"] <= 0 ||
    typeof value["holder_id"] !== "string" ||
    value["holder_id"].length === 0 ||
    !isRfc3339(value["heartbeat_at"]) ||
    !isRfc3339(value["acquired_at"])
  ) {
    return null;
  }
  return {
    pid: value["pid"],
    holder_id: value["holder_id"],
    heartbeat_at: value["heartbeat_at"],
    acquired_at: value["acquired_at"],
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function heartbeatAgeMs(
  heartbeatAt: string,
  nowMs: number,
): number {
  const then = Date.parse(heartbeatAt);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - then);
}

export class WriterLease {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private holder: LeaseHolder | null = null;
  private readonly heartbeatMs: number;
  private readonly now: () => string;

  constructor(
    private readonly dataDir: string,
    options: { heartbeat_ms?: number; clock?: () => string } = {},
  ) {
    this.heartbeatMs = options.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS;
    this.now = options.clock ?? (() => new Date().toISOString());
  }

  inspect(): LeaseSnapshot {
    const holder = this.readHolder();
    const nowMs = Date.parse(this.now());
    const live = holder !== null && isProcessAlive(holder.pid);
    const stale =
      holder !== null &&
      heartbeatAgeMs(holder.heartbeat_at, nowMs) >
        STALE_HEARTBEAT_MULTIPLIER * this.heartbeatMs;
    return {
      holder,
      queue_depth: this.readQueue().waiters.length,
      live,
      stale,
    };
  }

  tryAcquire(holderId: string): LeaseReceipt {
    ensureDir(dataPath(this.dataDir, "lease"));
    const existing = this.readHolder();
    const now = this.now();
    const nowMs = Date.parse(now);
    if (existing !== null) {
      if (isProcessAlive(existing.pid)) {
        throw new PortError(
          "lease_required",
          `writer lease is held by live pid ${existing.pid}`,
          true,
        );
      }
      const stale =
        heartbeatAgeMs(existing.heartbeat_at, nowMs) >
        STALE_HEARTBEAT_MULTIPLIER * this.heartbeatMs;
      if (!stale) {
        throw new PortError(
          "lease_required",
          "writer lease heartbeat is still fresh",
          true,
        );
      }
      this.forceRemoveHeld();
      const holder = this.writeHolder(holderId, now);
      const receipt: LeaseReceipt = {
        action: "reclaimed",
        previous: existing,
        holder,
        at: now,
      };
      this.appendReceipt(receipt);
      this.startHeartbeat();
      return receipt;
    }

    this.createHeldDir();
    const holder = this.writeHolder(holderId, now);
    const receipt: LeaseReceipt = {
      action: "acquired",
      previous: null,
      holder,
      at: now,
    };
    this.appendReceipt(receipt);
    this.startHeartbeat();
    return receipt;
  }

  async acquire(
    holderId: string,
    timeoutMs: number,
  ): Promise<LeaseReceipt> {
    const waiterId = `${holderId}:${Date.now()}`;
    this.enqueue(waiterId);
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() <= deadline) {
        try {
          const receipt = this.tryAcquire(holderId);
          this.dequeue(waiterId);
          return receipt;
        } catch (error) {
          if (
            !(error instanceof PortError) ||
            error.code !== "lease_required"
          ) {
            throw error;
          }
        }
        await sleep(Math.min(20, Math.max(1, this.heartbeatMs / 4)));
      }
      const depth = this.readQueue().waiters.length;
      throw new PortError(
        "timeout",
        `writer lease starvation; queue_depth=${depth}`,
        true,
      );
    } finally {
      this.dequeue(waiterId);
    }
  }

  heartbeat(): void {
    if (this.holder === null) return;
    const next: LeaseHolder = {
      ...this.holder,
      heartbeat_at: this.now(),
    };
    writeAtomic(
      dataPath(this.dataDir, LEASE_HOLDER_REL),
      `${JSON.stringify(next)}\n`,
    );
    this.holder = next;
  }

  release(): LeaseReceipt | null {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const previous = this.holder ?? this.readHolder();
    this.holder = null;
    this.forceRemoveHeld();
    if (previous === null) return null;
    const receipt: LeaseReceipt = {
      action: "released",
      previous,
      holder: null,
      at: this.now(),
    };
    this.appendReceipt(receipt);
    return receipt;
  }

  readReceipts(): LeaseReceipt[] {
    const path = dataPath(this.dataDir, LEASE_RECEIPTS_REL);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LeaseReceipt);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        // A closed or raced lease stops heartbeats on the next release.
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private createHeldDir(): void {
    const held = dataPath(this.dataDir, LEASE_HELD_REL);
    try {
      ensureDir(dataPath(this.dataDir, "lease"));
      mkdirSync(held, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (existsSync(held)) {
        throw new PortError(
          "lease_required",
          "writer lease directory is already held",
          true,
        );
      }
      throw error;
    }
  }

  private writeHolder(holderId: string, at: string): LeaseHolder {
    const holder: LeaseHolder = {
      pid: process.pid,
      holder_id: holderId,
      heartbeat_at: at,
      acquired_at: at,
    };
    writeAtomic(
      dataPath(this.dataDir, LEASE_HOLDER_REL),
      `${JSON.stringify(holder)}\n`,
    );
    this.holder = holder;
    return holder;
  }

  private readHolder(): LeaseHolder | null {
    const path = dataPath(this.dataDir, LEASE_HOLDER_REL);
    if (!existsSync(path)) return null;
    try {
      return parseHolder(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private forceRemoveHeld(): void {
    const held = dataPath(this.dataDir, LEASE_HELD_REL);
    if (existsSync(held)) {
      rmSync(held, { recursive: true, force: true });
    }
  }

  private readQueue(): QueueState {
    const path = dataPath(this.dataDir, LEASE_QUEUE_REL);
    if (!existsSync(path)) return { waiters: [] };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (
        !isPlainObject(raw) ||
        !Array.isArray(raw["waiters"]) ||
        !raw["waiters"].every((item) => typeof item === "string")
      ) {
        return { waiters: [] };
      }
      return { waiters: [...(raw["waiters"] as string[])] };
    } catch {
      return { waiters: [] };
    }
  }

  private enqueue(waiterId: string): void {
    const queue = this.readQueue();
    if (!queue.waiters.includes(waiterId)) queue.waiters.push(waiterId);
    writeAtomic(
      dataPath(this.dataDir, LEASE_QUEUE_REL),
      `${JSON.stringify(queue)}\n`,
    );
  }

  private dequeue(waiterId: string): void {
    const queue = this.readQueue();
    writeAtomic(
      dataPath(this.dataDir, LEASE_QUEUE_REL),
      `${JSON.stringify({
        waiters: queue.waiters.filter((item) => item !== waiterId),
      })}\n`,
    );
  }

  private appendReceipt(receipt: LeaseReceipt): void {
    const path = dataPath(this.dataDir, LEASE_RECEIPTS_REL);
    ensureDir(dataPath(this.dataDir, "lease"));
    appendFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function writeSyntheticHolder(
  dataDir: string,
  holder: LeaseHolder,
): void {
  ensureDir(dataPath(dataDir, LEASE_HELD_REL));
  writeAtomic(
    dataPath(dataDir, LEASE_HOLDER_REL),
    `${JSON.stringify(holder)}\n`,
  );
}
