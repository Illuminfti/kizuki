import { statSync } from "node:fs";
import { join } from "node:path";

export interface LiveVersions {
  vault: number;
  board: number;
  actions: number;
  taste: number;
  codex: number;
}

export interface LiveBusStatus {
  connected_clients: number;
  watcher_active: boolean;
  events_emitted: number;
  versions: LiveVersions;
}

export interface LiveDeltaPayload {
  id: number;
  ts: string;
  scopes: string[];
  versions: LiveVersions;
  meta?: Record<string, unknown>;
}

export interface LiveBusOptions {
  vaultApi?: {
    getDb?: () => { query: (sql: string) => { get: () => unknown } };
    vaultPath?: string;
    actionsPath?: string;
  };
  agentBoardApi?: {
    getDataVersion?: () => number;
  };
  actionsPath?: string;
  tastePath?: string;
  tasteCodexPath?: string;
  codexPath?: string;
  watchIntervalMs?: number;
  keepaliveIntervalMs?: number;
  readVersions?: () => LiveVersions;
  onInvalidate?: (scope: string) => void;
}

interface LiveClient {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  detachSignal?: () => void;
}

const DEFAULT_WATCH_INTERVAL_MS = 2_500;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;
const ENCODER = new TextEncoder();
const KEEPALIVE_BYTES = ENCODER.encode(": keepalive\n\n");

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
};

function safeMtimeMs(filePath: string | null | undefined): number {
  if (!filePath) return 0;
  try {
    const st = statSync(filePath);
    return Math.trunc(st.mtimeMs);
  } catch {
    return 0;
  }
}

function invokeHotCacheInvalidate(scope: string, customCb?: (s: string) => void): void {
  if (typeof customCb === "function") {
    try {
      customCb(scope);
    } catch {
      // ignore invalidation callback errors
    }
  }
  const g = globalThis as unknown as {
    __kizukiHotCacheInvalidate?: (scope: string) => void;
  };
  if (typeof g.__kizukiHotCacheInvalidate === "function") {
    try {
      g.__kizukiHotCacheInvalidate(scope);
    } catch {
      // ignore global hot-cache errors
    }
  }
}

export class LiveEventBus {
  private readonly opts: LiveBusOptions;
  private readonly watchIntervalMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly actionsPath: string | null;
  private readonly tastePath: string | null;
  private readonly tasteCodexPath: string | null;
  private readonly codexPath: string | null;

  private readonly clients = new Set<LiveClient>();
  private watcherTimer: ReturnType<typeof setInterval> | null = null;
  private lastKeepaliveAt = 0;
  private nextClientId = 1;
  private nextEventId = 1;
  private eventsEmitted = 0;
  private versions: LiveVersions;

  constructor(opts: LiveBusOptions = {}) {
    this.opts = opts;
    this.watchIntervalMs =
      typeof opts.watchIntervalMs === "number" && opts.watchIntervalMs >= 10
        ? opts.watchIntervalMs
        : DEFAULT_WATCH_INTERVAL_MS;
    this.keepaliveIntervalMs =
      typeof opts.keepaliveIntervalMs === "number" && opts.keepaliveIntervalMs >= 50
        ? opts.keepaliveIntervalMs
        : DEFAULT_KEEPALIVE_INTERVAL_MS;

    const vaultPath = opts.vaultApi?.vaultPath || "";
    this.actionsPath =
      opts.actionsPath ??
      opts.vaultApi?.actionsPath ??
      (vaultPath ? join(vaultPath, "owner-actions.json") : null);
    this.tastePath =
      opts.tastePath ??
      (vaultPath ? join(vaultPath, "world", "taste-profile.json") : null);
    this.tasteCodexPath =
      opts.tasteCodexPath ??
      (vaultPath ? join(vaultPath, "world", "taste-codex.md") : null);
    this.codexPath =
      opts.codexPath ??
      (vaultPath ? join(vaultPath, "world", "codex.json") : null);

    this.versions = this.readVersions();
  }

  readVersions(): LiveVersions {
    if (typeof this.opts.readVersions === "function") {
      try {
        const custom = this.opts.readVersions();
        return {
          vault: Number(custom.vault) || 0,
          board: Number(custom.board) || 0,
          actions: Number(custom.actions) || 0,
          taste: Number(custom.taste) || 0,
          codex: Number(custom.codex) || 0,
        };
      } catch {
        return { vault: 0, board: 0, actions: 0, taste: 0, codex: 0 };
      }
    }

    let vault = 0;
    try {
      const db = this.opts.vaultApi?.getDb?.();
      if (db && typeof db.query === "function") {
        const row = db.query("PRAGMA data_version").get() as { data_version?: number } | null;
        vault = Number(row?.data_version) || 0;
      }
    } catch {
      vault = 0;
    }

    let board = 0;
    try {
      if (typeof this.opts.agentBoardApi?.getDataVersion === "function") {
        board = Number(this.opts.agentBoardApi.getDataVersion()) || 0;
      }
    } catch {
      board = 0;
    }

    const actions = safeMtimeMs(this.actionsPath);
    const taste = safeMtimeMs(this.tastePath) + safeMtimeMs(this.tasteCodexPath);
    const codex = safeMtimeMs(this.codexPath);

    return { vault, board, actions, taste, codex };
  }

  getStatus(): LiveBusStatus {
    return {
      connected_clients: this.clients.size,
      watcher_active: this.watcherTimer !== null,
      events_emitted: this.eventsEmitted,
      versions: { ...this.versions },
    };
  }

  connect(signal?: AbortSignal): Response {
    let client: LiveClient | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (signal?.aborted) {
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }

        if (this.clients.size === 0) {
          this.versions = this.readVersions();
        }

        const entry: LiveClient = {
          id: this.nextClientId++,
          controller,
          closed: false,
        };
        client = entry;

        if (signal) {
          const onAbort = () => {
            this.removeClient(entry, true);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.detachSignal = () => {
            signal.removeEventListener("abort", onAbort);
          };
        }

        this.clients.add(entry);
        this.ensureWatcher();

        const connectedChunk = this.formatEvent("connected", {
          ts: new Date().toISOString(),
          versions: { ...this.versions },
        });
        this.eventsEmitted += 1;
        this.writeToClient(entry, connectedChunk);
      },
      cancel: () => {
        if (client) {
          this.removeClient(client, false);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { ...SSE_HEADERS },
    });
  }

  broadcast(scope: string | string[], meta?: Record<string, unknown>): LiveDeltaPayload {
    const rawScopes = Array.isArray(scope) ? scope : [scope];
    const scopes: string[] = [];
    const seen = new Set<string>();
    for (const s of rawScopes) {
      const clean = String(s || "").trim().toLowerCase();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        scopes.push(clean);
      }
    }
    if (scopes.length === 0) {
      scopes.push("all");
    }

    this.versions = this.readVersions();
    for (const sc of scopes) {
      invokeHotCacheInvalidate(sc, this.opts.onInvalidate);
    }

    const payload: LiveDeltaPayload = {
      id: this.nextEventId++,
      ts: new Date().toISOString(),
      scopes,
      versions: { ...this.versions },
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    };

    if (this.clients.size > 0) {
      const bytes = this.formatEvent("delta", payload);
      this.eventsEmitted += 1;
      this.writeAll(bytes);
    }

    return payload;
  }

  tickNow(): string[] {
    if (this.clients.size === 0) {
      this.stopWatcher();
      return [];
    }

    const next = this.readVersions();
    const prev = this.versions;
    const scopeSet = new Set<string>();

    if (next.vault !== prev.vault) {
      scopeSet.add("today");
      scopeSet.add("stream");
      scopeSet.add("people");
      scopeSet.add("graph");
      scopeSet.add("intel");
    }
    if (next.board !== prev.board) {
      scopeSet.add("board");
      scopeSet.add("today");
      scopeSet.add("intel");
    }
    if (next.actions !== prev.actions) {
      scopeSet.add("today");
      scopeSet.add("codex");
      scopeSet.add("intel");
    }
    if (next.taste !== prev.taste) {
      scopeSet.add("taste");
      scopeSet.add("today");
    }
    if (next.codex !== prev.codex) {
      scopeSet.add("codex");
      scopeSet.add("today");
    }

    this.versions = next;

    const scopes = Array.from(scopeSet);
    if (scopes.length > 0) {
      for (const sc of scopes) {
        invokeHotCacheInvalidate(sc, this.opts.onInvalidate);
      }
      const payload: LiveDeltaPayload = {
        id: this.nextEventId++,
        ts: new Date().toISOString(),
        scopes,
        versions: { ...this.versions },
      };
      const bytes = this.formatEvent("delta", payload);
      this.eventsEmitted += 1;
      this.writeAll(bytes);
      this.lastKeepaliveAt = Date.now();
      return scopes;
    }

    const now = Date.now();
    if (now - this.lastKeepaliveAt >= this.keepaliveIntervalMs) {
      this.lastKeepaliveAt = now;
      this.writeAll(KEEPALIVE_BYTES);
    }

    return [];
  }

  close(): void {
    const snapshot = Array.from(this.clients);
    for (const client of snapshot) {
      this.removeClient(client, true);
    }
    this.stopWatcher();
  }

  private ensureWatcher(): void {
    if (this.watcherTimer !== null || this.clients.size === 0) return;
    this.lastKeepaliveAt = Date.now();
    this.watcherTimer = setInterval(() => {
      this.tickNow();
    }, this.watchIntervalMs);
    if (typeof (this.watcherTimer as { unref?: () => void }).unref === "function") {
      (this.watcherTimer as { unref: () => void }).unref();
    }
  }

  private stopWatcher(): void {
    if (this.watcherTimer !== null) {
      clearInterval(this.watcherTimer);
      this.watcherTimer = null;
    }
  }

  private formatEvent(eventName: string, data: unknown): Uint8Array {
    return ENCODER.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private writeToClient(client: LiveClient, chunk: Uint8Array): void {
    if (client.closed) return;
    try {
      client.controller.enqueue(chunk);
    } catch {
      this.removeClient(client, false);
    }
  }

  private writeAll(chunk: Uint8Array): void {
    for (const client of Array.from(this.clients)) {
      this.writeToClient(client, chunk);
    }
  }

  private removeClient(client: LiveClient, closeController: boolean): void {
    if (client.closed) return;
    client.closed = true;
    if (client.detachSignal) {
      try {
        client.detachSignal();
      } catch {
        // ignore
      }
      client.detachSignal = undefined;
    }
    this.clients.delete(client);
    if (closeController) {
      try {
        client.controller.close();
      } catch {
        // ignore already closed stream
      }
    }
    if (this.clients.size === 0) {
      this.stopWatcher();
    }
  }
}
