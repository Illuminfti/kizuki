import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExperienceBank,
  MEMT_PROTOCOL_VERSION,
  MEMT_SNAPSHOT_FORMAT,
  MemTClient,
  MemTClientError,
  MemTCustodyError,
  MemtEngine,
  SnapshotCustodyRegistry,
  buildCommitRid,
  buildMinimalSafetensorsBuffer,
  buildQueryRid,
  chunkTextByTokens,
  createMemtEngine,
  fuseHybridRecall,
  loadMemtConfig,
  openMemtRegistryDb,
  parseMemTRid,
  validateMemTSnapshotBytes,
  validateMemTSnapshotFile,
} from "../src/index";

interface MockSessionState {
  session: string;
  epoch: string;
  memory_read: boolean;
  retain_kv: boolean;
  lease: string | null;
  lease_expires_at: string | null;
  active_transaction: string | null;
  committed_tokens: number;
  committed_text: string[];
  transactions: Record<
    string,
    {
      transaction: string;
      state: "open" | "committed" | "published" | "aborted";
      committed_tokens: number;
      committed_chunks: number;
      staged_text: string[];
      updated_at: string;
    }
  >;
  last_transaction: {
    transaction: string;
    state: "open" | "committed" | "published" | "aborted";
    committed_tokens: number;
    committed_chunks: number;
    updated_at: string;
  } | null;
}

class MockMemTServer {
  epoch = "epoch-1";
  identity = {
    model: "memt-nano",
    config_sha256: "a".repeat(64),
    checkpoint_id: "MemTensor/MemT-1.0-Nano@rev-20261124",
    sglang_version: "0.4.6-memt",
    memt_runtime: {
      enabled: true,
      num_layers: 2,
      num_heads: 2,
      key_dim: 4,
      value_dim: 4,
    },
  };
  capabilities = {
    protocol: MEMT_PROTOCOL_VERSION,
    snapshot_format: MEMT_SNAPSHOT_FORMAT,
    chunk_tokens: 32,
    max_prefill_tokens: 8192,
    commit_chunk_policy: "atomic",
    max_commit_tokens: 128,
    streaming: false,
    retain_kv: true,
  };
  sessions = new Map<string, MockSessionState>();
  snapshots = new Map<string, string[]>();
  nextSessionSeq = 1;
  nextLeaseSeq = 1;
  nextTxSeq = 1;
  failNextPublishAfterCommit = false;
  failNextCommitHttp500 = false;
  requiredApiKey: string | null = null;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;

  constructor(private readonly snapshotDir: string) {
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handle(req),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  restartWithNewEpoch(newEpoch: string): void {
    this.epoch = newEpoch;
    this.sessions.clear();
  }

  stop(): void {
    this.server.stop(true);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private async handle(req: Request): Promise<Response> {
    if (this.requiredApiKey !== null) {
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${this.requiredApiKey}`) {
        return this.json({ error: { code: "unauthorized", message: "bad api key" } }, 401);
      }
    }

    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/memt/identity") {
      return this.json(this.identity);
    }
    if (req.method === "GET" && url.pathname === "/memt/capabilities") {
      return this.json({ ...this.capabilities, epoch: this.epoch });
    }
    if (req.method === "POST" && url.pathname === "/memt/control") {
      const body = (await req.json()) as Record<string, unknown>;
      return this.handleControl(body);
    }
    if (req.method === "POST" && url.pathname === "/generate") {
      const body = (await req.json()) as Record<string, unknown>;
      return this.handleGenerate(body);
    }
    return this.json({ error: "not_found" }, 404);
  }

  private handleControl(body: Record<string, unknown>): Response {
    const action = String(body["action"] ?? "");
    const reqEpoch =
      typeof body["epoch"] === "string" ? body["epoch"] : undefined;
    if (
      reqEpoch !== undefined &&
      reqEpoch !== this.epoch &&
      action !== "create"
    ) {
      return this.json(
        {
          error: {
            code: "epoch_mismatch",
            message: `epoch mismatch: expected ${this.epoch}`,
            epoch: this.epoch,
          },
        },
        412,
      );
    }

    if (action === "create") {
      const id =
        typeof body["session"] === "string" && body["session"].length > 0
          ? body["session"]
          : `sess-${this.nextSessionSeq++}`;
      const source = typeof body["source"] === "string" ? body["source"] : null;
      let copiedText: string[] = [];
      if (source !== null) {
        const src = this.sessions.get(source);
        if (src === undefined) {
          return this.json({ error: { code: "not_found", message: "source session missing" } }, 404);
        }
        if (src.lease !== null && body["source_lease"] !== src.lease) {
          return this.json({ error: { code: "lease_conflict", message: "source_lease mismatch" } }, 409);
        }
        copiedText = [...src.committed_text];
      }
      const lease = `lease-${this.nextLeaseSeq++}`;
      const ttl = typeof body["ttl"] === "number" ? body["ttl"] : 300;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const state: MockSessionState = {
        session: id,
        epoch: this.epoch,
        memory_read: body["memory_read"] === false ? false : true,
        retain_kv: Boolean(body["retain_kv"]),
        lease,
        lease_expires_at: expiresAt,
        active_transaction: null,
        committed_tokens: copiedText.length * 10,
        committed_text: copiedText,
        transactions: {},
        last_transaction: null,
      };
      this.sessions.set(id, state);
      return this.json({
        ok: true,
        action: "create",
        session: id,
        epoch: this.epoch,
        lease,
        lease_expires_at: expiresAt,
        memory_read: state.memory_read,
        retain_kv: state.retain_kv,
      });
    }

    const sessionId = String(body["session"] ?? "");
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return this.json(
        { error: { code: "session_not_found", message: "unknown session" } },
        404,
      );
    }

    if (action === "acquire") {
      if (session.lease !== null) {
        return this.json(
          {
            error: {
              code: "lease_conflict",
              message: "session already leased by another holder",
            },
          },
          409,
        );
      }
      const ttl = typeof body["ttl"] === "number" ? body["ttl"] : 300;
      session.lease = `lease-${this.nextLeaseSeq++}`;
      session.lease_expires_at = new Date(Date.now() + ttl * 1000).toISOString();
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        lease: session.lease,
        lease_expires_at: session.lease_expires_at,
      });
    }

    if (action === "renew") {
      if (session.lease !== body["lease"]) {
        return this.json(
          { error: { code: "lease_conflict", message: "invalid lease" } },
          409,
        );
      }
      const ttl = typeof body["ttl"] === "number" ? body["ttl"] : 300;
      session.lease_expires_at = new Date(Date.now() + ttl * 1000).toISOString();
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        lease: session.lease,
        lease_expires_at: session.lease_expires_at,
      });
    }

    if (action === "release") {
      if (session.lease !== null && session.lease !== body["lease"]) {
        return this.json(
          { error: { code: "lease_conflict", message: "cannot release foreign lease" } },
          409,
        );
      }
      session.lease = null;
      session.lease_expires_at = null;
      return this.json({ ok: true, action, session: session.session, epoch: this.epoch });
    }

    if (action === "memory_read") {
      session.memory_read = Boolean(body["memory_read"]);
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        memory_read: session.memory_read,
      });
    }

    if (action === "inspect") {
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        state: {
          session: session.session,
          epoch: this.epoch,
          memory_read: session.memory_read,
          retain_kv: session.retain_kv,
          lease: session.lease,
          lease_expires_at: session.lease_expires_at,
          active_transaction: session.active_transaction,
          committed_tokens: session.committed_tokens,
          transactions: Object.fromEntries(
            Object.entries(session.transactions).map(([k, v]) => [
              k,
              {
                transaction: v.transaction,
                state: v.state,
                committed_tokens: v.committed_tokens,
                committed_chunks: v.committed_chunks,
                updated_at: v.updated_at,
              },
            ]),
          ),
          last_transaction: session.last_transaction,
        },
      });
    }

    if (action === "close") {
      this.sessions.delete(session.session);
      return this.json({ ok: true, action, session: session.session, epoch: this.epoch });
    }

    // Mutating operations require active matching lease.
    if (session.lease === null || session.lease !== body["lease"]) {
      return this.json(
        { error: { code: "lease_conflict", message: "lease required or mismatched" } },
        409,
      );
    }

    if (action === "begin") {
      if (session.active_transaction !== null) {
        return this.json(
          { error: { code: "transaction_conflict", message: "transaction already active" } },
          409,
        );
      }
      const txId = `tx-${this.nextTxSeq++}`;
      const now = new Date().toISOString();
      session.active_transaction = txId;
      session.transactions[txId] = {
        transaction: txId,
        state: "open",
        committed_tokens: 0,
        committed_chunks: 0,
        staged_text: [],
        updated_at: now,
      };
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        transaction: txId,
      });
    }

    if (action === "publish") {
      const txId = String(body["transaction"] ?? "");
      const tx = session.transactions[txId];
      if (tx === undefined || session.active_transaction !== txId) {
        return this.json(
          { error: { code: "invalid_transaction", message: "transaction not open" } },
          409,
        );
      }
      tx.state = "published";
      tx.updated_at = new Date().toISOString();
      session.committed_tokens += tx.committed_tokens;
      session.committed_text.push(...tx.staged_text);
      session.active_transaction = null;
      session.last_transaction = {
        transaction: tx.transaction,
        state: tx.state,
        committed_tokens: tx.committed_tokens,
        committed_chunks: tx.committed_chunks,
        updated_at: tx.updated_at,
      };

      if (this.failNextPublishAfterCommit) {
        this.failNextPublishAfterCommit = false;
        return this.json(
          { error: { code: "internal_error", message: "simulated drop after commit" } },
          503,
        );
      }

      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        transaction: txId,
        committed_tokens: session.committed_tokens,
        receipt: session.last_transaction,
      });
    }

    if (action === "abort") {
      const txId = String(body["transaction"] ?? "");
      const tx = session.transactions[txId];
      if (tx !== undefined) {
        tx.state = "aborted";
        tx.updated_at = new Date().toISOString();
        session.last_transaction = {
          transaction: tx.transaction,
          state: "aborted",
          committed_tokens: 0,
          committed_chunks: 0,
          updated_at: tx.updated_at,
        };
      }
      if (session.active_transaction === txId) {
        session.active_transaction = null;
      }
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        transaction: txId,
      });
    }

    if (action === "export") {
      const name =
        typeof body["name"] === "string" && body["name"].length > 0
          ? body["name"]
          : `${session.session}.safetensors`;
      const outPath =
        typeof body["path"] === "string" && body["path"].length > 0
          ? body["path"]
          : join(this.snapshotDir, name);
      const buf = buildMinimalSafetensorsBuffer({
        identity: this.identity.config_sha256,
        layers: [
          { layer: 0, shape: [1, 2, 4, 4], dtype: "F32" },
          { layer: 1, shape: [1, 2, 4, 4], dtype: "F32" },
        ],
      });
      writeFileSync(outPath, buf);
      this.snapshots.set(name, [...session.committed_text]);
      this.snapshots.set(outPath, [...session.committed_text]);
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        snapshot_name: name,
        snapshot_path: outPath,
      });
    }

    if (action === "import") {
      const key =
        typeof body["path"] === "string" && this.snapshots.has(body["path"])
          ? body["path"]
          : typeof body["name"] === "string" && this.snapshots.has(body["name"])
            ? body["name"]
            : null;
      if (key === null) {
        return this.json(
          { error: { code: "snapshot_not_found", message: "snapshot missing" } },
          404,
        );
      }
      session.committed_text = [...(this.snapshots.get(key) ?? [])];
      return this.json({
        ok: true,
        action,
        session: session.session,
        epoch: this.epoch,
        snapshot_name: typeof body["name"] === "string" ? body["name"] : key,
        snapshot_path: typeof body["path"] === "string" ? body["path"] : key,
      });
    }

    return this.json({ error: { code: "unsupported_action", message: action } }, 400);
  }

  private handleGenerate(body: Record<string, unknown>): Response {
    const rid = String(body["rid"] ?? "");
    const parsed = parseMemTRid(rid);
    if (parsed === null) {
      return this.json({ error: { code: "invalid_rid", message: rid } }, 400);
    }
    if (body["memt_epoch"] !== this.epoch) {
      return this.json(
        {
          error: {
            code: "epoch_mismatch",
            message: `expected epoch ${this.epoch}`,
            epoch: this.epoch,
          },
        },
        412,
      );
    }
    const session = this.sessions.get(parsed.session);
    if (session === undefined) {
      return this.json({ error: { code: "session_not_found", message: parsed.session } }, 404);
    }

    const sp = body["sampling_params"] as Record<string, unknown> | undefined;
    if (sp?.["n"] !== 1 || sp?.["ignore_eos"] !== false) {
      return this.json({ error: { code: "invalid_sampling_params" } }, 400);
    }

    if (parsed.mode === "commit") {
      if (sp?.["max_new_tokens"] !== 0) {
        return this.json({ error: { code: "commit_max_new_tokens_must_be_zero" } }, 400);
      }
      if (session.lease === null || session.lease !== body["memt_lease"]) {
        return this.json({ error: { code: "lease_conflict" } }, 409);
      }
      const txId = String(body["memt_transaction"] ?? "");
      const tx = session.transactions[txId];
      if (tx === undefined || session.active_transaction !== txId) {
        return this.json({ error: { code: "invalid_transaction" } }, 409);
      }
      if (this.failNextCommitHttp500) {
        this.failNextCommitHttp500 = false;
        return this.json(
          { error: { code: "commit_timeout", message: "simulated 500 during commit" } },
          500,
        );
      }
      tx.staged_text.push(String(body["text"] ?? ""));
      tx.committed_tokens += parsed.tokenCount ?? 0;
      tx.committed_chunks += 1;
      tx.updated_at = new Date().toISOString();
      return this.json({
        text: "",
        rid,
        memt_epoch: this.epoch,
        meta_info: { prompt_tokens: parsed.tokenCount ?? 0, completion_tokens: 0 },
      });
    }

    const memPrefix =
      session.memory_read && session.committed_text.length > 0
        ? `[MEM:${session.committed_text.length}] ${session.committed_text[0]?.slice(0, 60)}`
        : "[MEM:EMPTY]";
    return this.json({
      text: `${memPrefix} :: Answer for ${String(body["text"] ?? "").slice(0, 40)}`,
      rid,
      memt_epoch: this.epoch,
      meta_info: { prompt_tokens: 16, completion_tokens: 12 },
    });
  }
}

let tempRoot = "";
let mockServer: MockMemTServer;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "kizuki-memt-test-"));
  chmodSync(tempRoot, 0o700);
  mockServer = new MockMemTServer(join(tempRoot, "server-snapshots"));
});

afterAll(() => {
  mockServer.stop();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("memt-http-v1 protocol & client", () => {
  test("RID builders and parsers enforce exact memt-http-v1 grammar", () => {
    const q = buildQueryRid("sess_01", "abc123");
    expect(q).toBe("memt|sess_01|query|abc123");
    expect(parseMemTRid(q)).toEqual({
      session: "sess_01",
      mode: "query",
      nonce: "abc123",
    });

    const c = buildCommitRid("sess_01", 2048, "def456");
    expect(c).toBe("memt|sess_01|commit:2048|def456");
    expect(parseMemTRid(c)).toEqual({
      session: "sess_01",
      mode: "commit",
      tokenCount: 2048,
      nonce: "def456",
    });

    expect(parseMemTRid("memt|sess|commit:0|abc")).toBeNull();
    expect(parseMemTRid("bad|sess|query|abc")).toBeNull();
    expect(() => buildQueryRid("bad|session")).toThrow(MemTClientError);
    expect(() => buildCommitRid("sess", 0)).toThrow(MemTClientError);
  });

  test("identity, capabilities, full session lifecycle, fork, chunked ingest, snapshots, and 409 lease conflict", async () => {
    const client = new MemTClient({ baseUrl: mockServer.baseUrl });
    const identity = await client.getIdentity();
    expect(identity.model).toBe("memt-nano");
    expect(identity.config_sha256).toBe("a".repeat(64));

    const caps = await client.getCapabilities();
    expect(caps.protocol).toBe("memt-http-v1");
    expect(caps.snapshot_format).toBe("memt-memory-v1");
    expect(caps.epoch).toBe("epoch-1");
    expect(caps.commit_chunk_policy).toBe("atomic");
    expect(caps.retain_kv).toBe(true);

    // Invalid TTL rejected client-side
    await expect(
      client.control({ action: "acquire", session: "x", ttl: 0 }),
    ).rejects.toThrow(MemTClientError);
    await expect(
      client.control({ action: "acquire", session: "x", ttl: 3601 }),
    ).rejects.toThrow(MemTClientError);

    const session = await client.createSession({
      memoryRead: true,
      retainKv: true,
      leaseTtlSeconds: 120,
    });
    expect(session.lease).not.toBeNull();

    // Competing client attempting to acquire same session lease receives 409 lease_conflict
    const competing = new MemTClient({ baseUrl: mockServer.baseUrl });
    competing.setEpoch(session.epoch);
    let conflictErr: unknown;
    try {
      await competing.control({
        action: "acquire",
        session: session.sessionId,
        ttl: 60,
      });
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeInstanceOf(MemTClientError);
    expect((conflictErr as MemTClientError).status).toBe(409);
    expect((conflictErr as MemTClientError).code).toBe("lease_conflict");

    // Renew lease
    const renewed = await session.renewLease(240);
    expect(renewed).toBe(session.lease!);

    // Commit turns & multi-chunk document
    const turnRes = await session.commitTurns([
      { role: "user", content: "Always run bunx tsc --noEmit before committing." },
      { role: "assistant", content: "Noted and stored in procedural memory." },
    ]);
    expect(turnRes.chunksCommitted).toBeGreaterThanOrEqual(1);
    expect(turnRes.transactions.length).toBeGreaterThanOrEqual(1);

    const longDoc = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}: Kizuki enforces receipted canon writes and purge totality.`,
    ).join("\n\n");
    const docRes = await session.ingestDocument(longDoc);
    expect(docRes.chunksCommitted).toBeGreaterThan(1);
    expect(docRes.tokensCommitted).toBeGreaterThan(32);

    // Query with memory_read=true vs false
    const q1 = await session.query("What does Kizuki enforce?");
    expect(q1.text).toContain("[MEM:");

    await session.setMemoryRead(false);
    const q2 = await session.query("What does Kizuki enforce?");
    expect(q2.text).toContain("[MEM:EMPTY]");
    await session.setMemoryRead(true);

    // Fork a derived session from source + source_lease
    const forked = await client.createSession({
      source: session.sessionId,
      sourceLease: session.lease!,
      memoryRead: true,
    });
    const forkedQ = await forked.query("Check inherited memory");
    expect(forkedQ.text).toContain("[MEM:");

    // Export and import `.safetensors` snapshot
    const snapPath = join(tempRoot, "exported-session.safetensors");
    const exported = await session.saveSnapshot({
      name: "test-export.safetensors",
      path: snapPath,
    });
    expect(exported.snapshotPath).toBe(snapPath);
    expect(validateMemTSnapshotFile(snapPath).ok).toBe(true);

    await forked.reset();
    const emptyQ = await forked.query("After reset");
    expect(emptyQ.text).toContain("[MEM:EMPTY]");

    await forked.loadSnapshot({ name: "test-export.safetensors", path: snapPath });
    const restoredQ = await forked.query("After import");
    expect(restoredQ.text).toContain("[MEM:");

    const status = await session.status();
    expect(status.serverState?.committed_tokens).toBeGreaterThan(0);

    await forked.close();
    await session.close();
    expect(session.isClosed).toBe(true);
  });

  test("uncertain write reconciliation via recover(): committed receipt, open tx abort, and epoch change after restart", async () => {
    const client = new MemTClient({ baseUrl: mockServer.baseUrl });
    const session = await client.createSession();

    // Case A: publish fails with HTTP 503 AFTER server committed
    mockServer.failNextPublishAfterCommit = true;
    let publishErr: unknown;
    try {
      await session.ingestDocument("Critical architecture invariant A");
    } catch (err) {
      publishErr = err;
    }
    expect(publishErr).toBeInstanceOf(MemTClientError);
    const e1 = publishErr as MemTClientError;
    expect(e1.uncertain).toBe(true);
    expect(e1.stage).toBe("publish");
    expect(e1.transaction).toBeDefined();
    expect(session.hasUncertainTransaction).toBe(true);

    // Refuses to blindly replay another write before recover()
    await expect(session.ingestDocument("Second write blocked")).rejects.toThrow(
      MemTClientError,
    );

    const recA = await session.recover();
    expect(recA.status).toBe("reconciled_committed");
    expect(recA.safeToRetry).toBe(false);
    expect(recA.epochChanged).toBe(false);
    expect(session.hasUncertainTransaction).toBe(false);

    // Case B: commit fails with HTTP 500 leaving transaction open on server
    mockServer.failNextCommitHttp500 = true;
    let commitErr: unknown;
    try {
      await session.ingestDocument("Transient commit failure B");
    } catch (err) {
      commitErr = err;
    }
    expect(commitErr).toBeInstanceOf(MemTClientError);
    expect((commitErr as MemTClientError).uncertain).toBe(true);
    expect((commitErr as MemTClientError).stage).toBe("commit");

    const recB = await session.recover();
    expect(recB.status).toBe("aborted_open_transaction");
    expect(recB.safeToRetry).toBe(true);
    expect(session.hasUncertainTransaction).toBe(false);

    // Now safe to retry commit
    const retryRes = await session.ingestDocument("Clean retry after abort");
    expect(retryRes.chunksCommitted).toBe(1);

    // Case C: server restarts and epoch increments
    mockServer.restartWithNewEpoch("epoch-2");
    const recC = await session.recover();
    expect(recC.status).toBe("epoch_changed");
    expect(recC.epochChanged).toBe(true);
    expect(recC.previousEpoch).toBe("epoch-1");
    expect(recC.currentEpoch).toBe("epoch-2");
    expect(recC.safeToRetry).toBe(false);

    await session.reset();
    expect(session.epoch).toBe("epoch-2");
    await session.close();
  });

  test("chunkTextByTokens splits safely on boundaries without breaking surrogates", () => {
    const emojiText = "Hello 🚀 world\n\nSecond paragraph 🌟 with unicode text!";
    const chunks = chunkTextByTokens(emojiText, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(emojiText);
  });
});

describe("memt-memory-v1 safetensors validator & SQLite custody registry", () => {
  test("accepts valid memt-memory-v1 safetensors and rejects legacy memory.layers.*, wrong dtype/shape, and bad headers", () => {
    const validBuf = buildMinimalSafetensorsBuffer({
      identity: "sha256:valid-identity",
      layers: [
        { layer: 0, shape: [1, 4, 8, 8], dtype: "F32" },
        { layer: 1, shape: [1, 4, 8, 8], dtype: "F32" },
      ],
    });
    const validRes = validateMemTSnapshotBytes(validBuf);
    expect(validRes.ok).toBe(true);
    if (validRes.ok) {
      expect(validRes.format).toBe("memt-memory-v1");
      expect(validRes.identity).toBe("sha256:valid-identity");
      expect(validRes.layers.length).toBe(2);
      expect(validRes.layers[0]?.shape).toEqual([1, 4, 8, 8]);
    }

    const filePath = join(tempRoot, "valid-check.safetensors");
    writeFileSync(filePath, validBuf);
    expect(validateMemTSnapshotFile(filePath).ok).toBe(true);

    // Reject legacy incompatible memory.layers.* format
    const legacyBuf = buildMinimalSafetensorsBuffer({
      identity: "sha256:legacy",
      layers: [{ name: "memory.layers.0", layer: 0, shape: [1, 2, 4, 4], dtype: "F32" }],
    });
    const legacyRes = validateMemTSnapshotBytes(legacyBuf);
    expect(legacyRes.ok).toBe(false);
    if (!legacyRes.ok) {
      expect(legacyRes.errors.some((e) => e.includes("memory.layers."))).toBe(true);
    }

    // Reject non-F32 dtype
    const f16Buf = buildMinimalSafetensorsBuffer({
      identity: "sha256:f16",
      layers: [{ layer: 0, shape: [1, 2, 4, 4], dtype: "F16" }],
    });
    expect(validateMemTSnapshotBytes(f16Buf).ok).toBe(false);

    // Reject non-4D or batch!=1 shape
    const badShapeBuf = buildMinimalSafetensorsBuffer({
      identity: "sha256:shape",
      layers: [{ layer: 0, shape: [2, 2, 4, 4], dtype: "F32" }],
    });
    expect(validateMemTSnapshotBytes(badShapeBuf).ok).toBe(false);

    // Reject empty identity
    const emptyIdBuf = buildMinimalSafetensorsBuffer({ identity: "   " });
    expect(validateMemTSnapshotBytes(emptyIdBuf).ok).toBe(false);

    // Reject wrong format
    const wrongFmtBuf = buildMinimalSafetensorsBuffer({
      identity: "id",
      format: "memt-memory-v0",
    });
    expect(validateMemTSnapshotBytes(wrongFmtBuf).ok).toBe(false);

    // Reject absurdly huge header length without allocating RAM
    const hugeLen = new Uint8Array(16);
    new DataView(hugeLen.buffer).setBigUint64(0, 999_999_999n, true);
    const hugeRes = validateMemTSnapshotBytes(hugeLen, 1_000_000_000);
    expect(hugeRes.ok).toBe(false);
  });

  test("custody registry enforces WAL, 0600 perms, sensitivity ceilings, and purge invalidation", () => {
    const vaultDir = join(tempRoot, "custody-vault");
    const dbPath = join(vaultDir, ".kizuki", "memt", "registry.sqlite");
    const db = openMemtRegistryDb(dbPath);
    try {
      const mode = statSync(dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
      const journalMode = db
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get()?.journal_mode;
      expect(journalMode).toBe("wal");

      const registry = new SnapshotCustodyRegistry({ db });
      registry.registerSnapshot({
        partition_key: "work:kizuki",
        sensitivity_ceiling: "personal",
        source_ids: ["01EVT001", "event:01EVT002"],
        snapshot_name: "work-kizuki.safetensors",
        identity_sha256: "abc123",
        event_watermark: "2026-11-24T00:00:00Z",
      });

      // Sensitivity ceiling enforcement
      expect(() =>
        registry.assertLoadable("work:kizuki", {
          requiredSensitivityCeiling: "public",
        }),
      ).toThrow(MemTCustodyError);

      expect(
        registry.assertLoadable("work:kizuki", {
          requiredSensitivityCeiling: "personal",
          expectedIdentitySha256: "abc123",
        }).taint_state,
      ).toBe("clean");

      // Purge invalidation (matches raw id against `event:`-prefixed source)
      const inv = registry.invalidateForPurgedSources(["01EVT002"]);
      expect(inv.invalidatedPartitions).toEqual(["work:kizuki"]);
      expect(registry.getSnapshot("work:kizuki")?.taint_state).toBe(
        "purged_invalidated",
      );

      // Purged snapshot can NEVER be loaded, even with allowStale: true
      let loadErr: unknown;
      try {
        registry.assertLoadable("work:kizuki", { allowStale: true });
      } catch (err) {
        loadErr = err;
      }
      expect(loadErr).toBeInstanceOf(MemTCustodyError);
      expect((loadErr as MemTCustodyError).code).toBe("purged_invalidated");

      // Rebuilding cleanly replaces taint_state back to clean
      registry.registerSnapshot({
        partition_key: "work:kizuki",
        sensitivity_ceiling: "personal",
        source_ids: ["01EVT001"],
        snapshot_name: "work-kizuki-v2.safetensors",
        identity_sha256: "abc123",
        event_watermark: "2026-11-24T01:00:00Z",
      });
      expect(registry.assertLoadable("work:kizuki").snapshot_name).toBe(
        "work-kizuki-v2.safetensors",
      );
    } finally {
      db.close();
    }
  });
});

describe("ExperienceBank procedural memory", () => {
  test("CRUD, deduplication, FTS5 + cosine vector RRF, sensitivity ceiling, internalization, and provenance purge", () => {
    const bank = new ExperienceBank({ dbPath: ":memory:" });
    try {
      const first = bank.recordExperience({
        domain: "kizuki-ops",
        scope_key: "canon-recovery",
        sensitivity: "work",
        condition: "Canon recovery fails with authority_changed when on-disk hash equals before_hash",
        recommendation: "Abort the unapplied write intent and clear canon-recovery-hold.json",
        verification: "Run kizuki doctor and confirm zero recovery holds",
        outcome: "observed",
        citations: ["event:01EVT_A"],
        confidence: 0.7,
        embedding: [1, 0, 0, 0],
      });
      expect(first.deduplicated).toBe(false);
      expect(first.experience.use_count).toBe(0);

      // Near-identical duplicate merges cleanly rather than creating a second row
      const dup = bank.recordExperience({
        domain: "kizuki-ops",
        scope_key: "canon-recovery",
        sensitivity: "personal",
        condition: "Canon recovery fails with authority_changed when on-disk hash equals before_hash!",
        recommendation: "Abort the unapplied write intent and clear canon-recovery-hold.json",
        outcome: "verified",
        citations: ["page:auto/recovery.md"],
        confidence: 0.85,
      });
      expect(dup.deduplicated).toBe(true);
      expect(dup.mergedIntoId).toBe(first.experience.id);
      expect(dup.experience.use_count).toBe(1);
      expect(dup.experience.outcome).toBe("verified");
      expect(dup.experience.sensitivity).toBe("personal"); // monotonic max
      expect(dup.experience.citations).toContain("event:01EVT_A");
      expect(dup.experience.citations).toContain("page:auto/recovery.md");

      // Private experience that lower ceilings must NEVER see
      bank.recordExperience({
        domain: "kizuki-ops",
        scope_key: "secrets",
        sensitivity: "private",
        condition: "Private SSH tunnel recovery procedure",
        recommendation: "Check private key permissions in ~/.ssh",
        outcome: "verified",
        citations: ["event:01EVT_PRIV"],
        confidence: 0.95,
        embedding: [0, 1, 0, 0],
      });

      // Public ceiling sees neither personal nor private
      expect(
        bank.searchExperiences({
          query: "recovery authority_changed",
          sensitivityCeiling: "public",
        }).length,
      ).toBe(0);

      // Personal ceiling sees personal experience but NOT private
      const personalHits = bank.searchExperiences({
        query: "recovery: authority_changed (before_hash)!",
        sensitivityCeiling: "personal",
        queryVector: [0.98, 0.05, 0, 0],
      });
      expect(personalHits.length).toBe(1);
      expect(personalHits[0]?.experience.id).toBe(first.experience.id);
      expect(personalHits[0]?.bm25Rank).toBe(1);
      expect(personalHits[0]?.vectorRank).toBe(1);
      expect((personalHits[0]?.cosineSimilarity ?? 0) > 0.9).toBe(true);

      // Mark verified / uninternalized tracking
      const pending = bank.getUninternalizedExperiences({ domain: "kizuki-ops" });
      expect(pending.length).toBe(2);
      const stamped = bank.markInternalized([first.experience.id], "snap-1.safetensors");
      expect(stamped).toBe(1);
      expect(
        bank.getUninternalizedExperiences({ domain: "kizuki-ops" }).length,
      ).toBe(1);

      // Purge by raw event id removes cited experience from main table & FTS5
      const purged = bank.purgeBySourceRefs(["01EVT_A"]);
      expect(purged.purgedCount).toBe(1);
      expect(purged.purgedIds).toEqual([first.experience.id]);
      expect(bank.getExperience(first.experience.id)).toBeNull();
      expect(
        bank.searchExperiences({
          query: "authority_changed",
          sensitivityCeiling: "private",
        }).length,
      ).toBe(0);
    } finally {
      bank.close();
    }
  });

  test("vector cache stays fresh across separate SQLite connections via PRAGMA data_version and countExperiences respects ceilings", () => {
    const sharedPath = join(tempRoot, "cross-conn-memt.sqlite");
    const bankA = new ExperienceBank({ dbPath: sharedPath });
    const bankB = new ExperienceBank({ dbPath: sharedPath });
    try {
      const e1 = bankA.recordExperience({
        domain: "ops",
        scope_key: "cache",
        sensitivity: "public",
        condition: "Initial public cache note",
        recommendation: "Warm cache vector A",
        outcome: "verified",
        citations: ["event:cc_1"],
        embedding: [1, 0, 0, 0],
      });

      // Warm bankA's in-memory vector cache
      const initialHits = bankA.searchExperiences({
        query: "",
        queryVector: [1, 0, 0, 0],
        sensitivityCeiling: "private",
        limit: 5,
      });
      expect(initialHits.map((h) => h.experience.id)).toEqual([e1.experience.id]);

      // Write via separate connection bankB -> PRAGMA data_version increments on bankA
      const e2 = bankB.recordExperience({
        domain: "ops",
        scope_key: "secret-cache",
        sensitivity: "private",
        condition: "Cross-connection private cache note",
        recommendation: "Return vector B on private queries",
        outcome: "observed",
        citations: ["event:cc_2"],
        embedding: [0, 1, 0, 0],
      });

      const refreshedHits = bankA.searchExperiences({
        query: "",
        queryVector: [0, 1, 0, 0],
        sensitivityCeiling: "private",
        limit: 5,
      });
      expect(refreshedHits.map((h) => h.experience.id)).toEqual([e2.experience.id]);

      // Aggregate counts respect sensitivity ceiling accurately
      expect(bankA.countExperiences({ sensitivityCeiling: "public" })).toEqual({
        total: 1,
        uninternalized: 1,
        verified: 1,
        observed: 0,
        failed: 0,
      });
      expect(bankA.countExperiences({ sensitivityCeiling: "private" })).toEqual({
        total: 2,
        uninternalized: 2,
        verified: 1,
        observed: 1,
        failed: 0,
      });

      // Purge via bankB -> bankA vector cache drops e2 immediately
      bankB.purgeBySourceRefs(["cc_2"]);
      const afterPurge = bankA.searchExperiences({
        query: "",
        queryVector: [0, 1, 0, 0],
        sensitivityCeiling: "private",
        limit: 5,
      });
      expect(afterPurge.length).toBe(0);
    } finally {
      bankA.close();
      bankB.close();
    }
  });
});

describe("MemtEngine dual-system hybrid engine", () => {
  test("loadMemtConfig reads [memt] from serve.toml and respects env overrides", () => {
    const vault = join(tempRoot, "cfg-vault");
    mkdirSync(join(vault, ".kizuki"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(vault, ".kizuki", "serve.toml"),
      `[memt]\nenabled = true\nurl = "http://127.0.0.1:30000"\nprobe_timeout_ms = 900\nrrf_k = 45\n`,
    );

    const fromToml = loadMemtConfig(vault, {});
    expect(fromToml.enabled).toBe(true);
    expect(fromToml.url).toBe("http://127.0.0.1:30000");
    expect(fromToml.probeTimeoutMs).toBe(900);
    expect(fromToml.rrfK).toBe(45);

    const withEnv = loadMemtConfig(vault, {
      KIZUKI_MEMT_URL: "http://127.0.0.1:31000/",
      KIZUKI_MEMT_API_KEY: "test-secret-token",
    });
    expect(withEnv.url).toBe("http://127.0.0.1:31000");
    expect(withEnv.apiKey).toBe("test-secret-token");

    // Updating serve.toml invalidates the stat-keyed config cache immediately
    writeFileSync(
      join(vault, ".kizuki", "serve.toml"),
      `[memt]\nenabled = true\nurl = "http://127.0.0.1:32000"\nprobe_timeout_ms = 1100\nrrf_k = 72\n`,
    );
    const updatedToml = loadMemtConfig(vault, {});
    expect(updatedToml.url).toBe("http://127.0.0.1:32000");
    expect(updatedToml.probeTimeoutMs).toBe(1100);
    expect(updatedToml.rrfK).toBe(72);
  });

  test("native-gpu mode internalizes experiences, validates snapshots, recalls with RRF, and enforces purge totality", async () => {
    const vault = join(tempRoot, "hybrid-gpu-vault");
    const engine = createMemtEngine(vault, {
      env: { KIZUKI_MEMT_URL: mockServer.baseUrl },
    });
    try {
      const st = await engine.probe({ force: true });
      expect(st.mode).toBe("native-gpu");
      expect(st.gpu_backend).toBe("online");
      expect(st.identity?.model).toBe("memt-nano");

      const rec = engine.experiences.recordExperience({
        domain: "engineering",
        scope_key: "bun-tests",
        sensitivity: "work",
        condition: "Running Kizuki tests locally",
        recommendation: "Always unset KIZUKI_VAULT and use a 0700 TMPDIR",
        verification: "Verify live vault mtime is unchanged",
        outcome: "verified",
        citations: ["event:01EVT_TEST_RULE"],
        confidence: 0.92,
      });

      const intRes = await engine.internalizePartition({
        partitionKey: "engineering",
        domain: "engineering",
        sensitivityCeiling: "work",
        eventWatermark: "2026-11-24T00:00:00Z",
      });
      expect(intRes.mode).toBe("native-gpu");
      expect(intRes.internalized).toBe(true);
      expect(intRes.experienceIds).toEqual([rec.experience.id]);
      expect(intRes.snapshotRecord?.taint_state).toBe("clean");
      expect(existsSync(intRes.snapshotPath!)).toBe(true);

      const recalled = await engine.recall({
        query: "Kizuki tests TMPDIR",
        domain: "engineering",
        partitionKey: "engineering",
        sensitivityCeiling: "personal",
        system2Hits: [
          {
            id: "event:01EVT_TEST_RULE",
            kind: "event",
            text: "Captured chat note: never touch live vault during tests",
            score: 0.9,
            sensitivity: "work",
            taint: "quoted",
            citations: ["event:01EVT_TEST_RULE"],
          },
        ],
      });

      expect(recalled.mode).toBe("native-gpu");
      expect(recalled.synthesis?.source).toBe("memt-native-gpu");
      expect(recalled.items.length).toBe(2);
      const s2Item = recalled.items.find((i) => i.source === "system2");
      expect(s2Item?.untrustedCapturedText).toBe(true);
      expect(s2Item?.trustTag).toBe("untrusted_captured_text");
      const expItem = recalled.items.find((i) => i.source === "experience");
      expect(expItem?.trustTag).toBe("verified_procedure");
      expect(expItem?.citations).toContain("event:01EVT_TEST_RULE");

      // Purge source -> invalidates snapshot AND deletes cited experience
      const purged = engine.purgeSources(["01EVT_TEST_RULE"]);
      expect(purged.snapshots.invalidatedPartitions).toEqual(["engineering"]);
      expect(purged.experiences.purgedCount).toBe(1);

      // Subsequent recall MUST NOT load the purged snapshot (degrades cleanly)
      const afterPurge = await engine.recall({
        query: "Kizuki tests TMPDIR",
        domain: "engineering",
        partitionKey: "engineering",
        sensitivityCeiling: "personal",
      });
      expect(afterPurge.degraded).toContain("memt-custody-purged_invalidated");
      expect(afterPurge.synthesis).toBeNull();
    } finally {
      await engine.close();
    }
  });

  test("local-hybrid offline fallback never stalls reads and reports honest offline status", async () => {
    const vault = join(tempRoot, "hybrid-offline-vault");
    let fetchCalls = 0;
    let fakeNow = 1_000_000;
    const engine = createMemtEngine(vault, {
      env: { KIZUKI_MEMT_URL: "http://127.0.0.1:1" },
      config: { probeTimeoutMs: 200, offlineBackoffMs: 30_000 },
      now: () => fakeNow,
      fetch: (async () => {
        fetchCalls += 1;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    try {
      engine.experiences.recordExperience({
        domain: "ops",
        scope_key: "health",
        sensitivity: "public",
        condition: "Health endpoint is slow under load",
        recommendation: "Cache /v1/health snapshot with a short TTL",
        outcome: "verified",
        citations: ["page:auto/ops/health.md"],
        confidence: 0.9,
      });

      const r1 = await engine.recall({
        query: "slow health endpoint",
        domain: "ops",
        sensitivityCeiling: "public",
        system2Hits: [
          {
            id: "page:auto/ops/health.md",
            kind: "page",
            title: "Health Endpoint",
            text: "Canon spec for /v1/health latency budget",
            score: 0.85,
            sensitivity: "public",
            taint: "clean",
            citations: ["page:auto/ops/health.md"],
          },
          {
            id: "page:private/secret.md",
            kind: "page",
            text: "Should be filtered by ceiling",
            score: 0.99,
            sensitivity: "private",
            taint: "clean",
            citations: ["page:private/secret.md"],
          },
        ],
      });

      expect(r1.mode).toBe("local-hybrid");
      expect(r1.degraded).toContain("memt-gpu-offline");
      expect(r1.synthesis?.source).toBe("local-experience-distill");
      expect(r1.items.some((i) => i.id === "page:private/secret.md")).toBe(false);
      expect(fetchCalls).toBe(1);

      // Second recall inside backoff window makes ZERO network calls (no stall!)
      fakeNow += 5_000;
      const r2 = await engine.recall({
        query: "slow health endpoint",
        domain: "ops",
        sensitivityCeiling: "public",
      });
      expect(r2.mode).toBe("local-hybrid");
      expect(fetchCalls).toBe(1);

      const st = await engine.status();
      expect(st.mode).toBe("local-hybrid");
      expect(st.gpu_backend).toBe("offline");
      expect(st.experience_count).toBe(1);
    } finally {
      await engine.close();
    }
  });

  test("fuseHybridRecall preserves provenance and untrusted tags cleanly", () => {
    const res = fuseHybridRecall({
      sensitivityCeiling: "personal",
      system2Hits: [
        {
          id: "event:ev1",
          kind: "event",
          text: "Untrusted message text",
          score: 0.8,
          sensitivity: "personal",
          taint: "quoted",
          citations: ["event:ev1"],
        },
        {
          id: "page:p1",
          kind: "page",
          text: "Receipted canon note",
          score: 0.7,
          sensitivity: "public",
          taint: "clean",
          citations: ["page:p1"],
        },
      ],
      experienceHits: [],
    });
    expect(res.items.length).toBe(2);
    expect(res.items[0]?.untrustedCapturedText).toBe(true);
    expect(res.items[1]?.untrustedCapturedText).toBe(false);
  });
});
