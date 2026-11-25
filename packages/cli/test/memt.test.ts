import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMT_PROTOCOL_VERSION,
  MEMT_SNAPSHOT_FORMAT,
  buildMinimalSafetensorsBuffer,
  parseMemTRid,
} from "@kizuki/memt";
import { createHelpers, fixtureConsent } from "./helpers";

setDefaultTimeout(60_000);

const { cleanup, isolatedEnv, runCli, runCliAsync, tempVault } = createHelpers();
afterEach(cleanup);

let serverRoot = "";
let mockServer: ReturnType<typeof Bun.serve>;
let mockUrl = "";
const serverSnapshots = new Map<string, string>();

beforeAll(() => {
  serverRoot = mkdtempSync(join(tmpdir(), "kizuki-cli-memt-srv-"));
  let txSeq = 1;
  let committedTokens = 0;

  mockServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (req.method === "GET" && url.pathname === "/memt/identity") {
        return reply({
          model: "memt-nano",
          config_sha256: "b".repeat(64),
          checkpoint_id: "MemTensor/MemT-1.0-Nano@cli-test",
          sglang_version: "0.4.6-memt",
          memt_runtime: { enabled: true, num_layers: 2, num_heads: 2, key_dim: 4, value_dim: 4 },
        });
      }
      if (req.method === "GET" && url.pathname === "/memt/capabilities") {
        return reply({
          protocol: MEMT_PROTOCOL_VERSION,
          snapshot_format: MEMT_SNAPSHOT_FORMAT,
          epoch: "cli-epoch-1",
          chunk_tokens: 64,
          max_prefill_tokens: 8192,
          commit_chunk_policy: "atomic",
          max_commit_tokens: 256,
          streaming: false,
          retain_kv: true,
        });
      }
      if (req.method === "POST" && url.pathname === "/memt/control") {
        const body = (await req.json()) as Record<string, unknown>;
        const action = String(body["action"] ?? "");
        const session = typeof body["session"] === "string" ? body["session"] : "cli-sess-1";
        if (action === "create") {
          return reply({
            ok: true,
            action: "create",
            session,
            epoch: "cli-epoch-1",
            lease: "lease-cli-1",
            lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
            memory_read: true,
            retain_kv: false,
          });
        }
        if (action === "begin") {
          return reply({
            ok: true,
            action: "begin",
            session,
            epoch: "cli-epoch-1",
            transaction: `tx-${txSeq++}`,
          });
        }
        if (action === "publish") {
          const tx = String(body["transaction"] ?? "tx-1");
          return reply({
            ok: true,
            action: "publish",
            session,
            epoch: "cli-epoch-1",
            transaction: tx,
            committed_tokens: committedTokens,
            receipt: {
              transaction: tx,
              state: "published",
              committed_tokens: committedTokens,
              committed_chunks: 1,
              updated_at: new Date().toISOString(),
            },
          });
        }
        if (action === "export") {
          const name = String(body["name"] ?? "export.safetensors");
          const outPath =
            typeof body["path"] === "string" ? body["path"] : join(serverRoot, name);
          mkdirSync(join(outPath, ".."), { recursive: true, mode: 0o700 });
          const bytes = buildMinimalSafetensorsBuffer({ identity: "b".repeat(64) });
          writeFileSync(outPath, bytes);
          serverSnapshots.set(name, outPath);
          return reply({
            ok: true,
            action: "export",
            session,
            epoch: "cli-epoch-1",
            snapshot_name: name,
            snapshot_path: outPath,
          });
        }
        if (action === "import" || action === "release" || action === "close" || action === "renew") {
          return reply({
            ok: true,
            action,
            session,
            epoch: "cli-epoch-1",
            lease: "lease-cli-1",
            snapshot_name: typeof body["name"] === "string" ? body["name"] : "export.safetensors",
            snapshot_path: typeof body["path"] === "string" ? body["path"] : undefined,
          });
        }
        return reply({ ok: true, action, session, epoch: "cli-epoch-1" });
      }
      if (req.method === "POST" && url.pathname === "/generate") {
        const body = (await req.json()) as Record<string, unknown>;
        const rid = parseMemTRid(String(body["rid"] ?? ""));
        if (rid?.mode === "commit") {
          committedTokens += rid.tokenCount ?? 16;
          return reply({
            text: "",
            rid: body["rid"],
            memt_epoch: "cli-epoch-1",
            meta_info: { prompt_tokens: rid.tokenCount ?? 16, completion_tokens: 0 },
          });
        }
        return reply({
          text: `MemT latent synthesis for: ${String(body["text"] ?? "").slice(0, 48)}`,
          rid: body["rid"],
          memt_epoch: "cli-epoch-1",
          meta_info: { prompt_tokens: 16, completion_tokens: 10 },
        });
      }
      return reply({ error: "not_found" }, 404);
    },
  });
  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop(true);
  rmSync(serverRoot, { recursive: true, force: true });
});

describe("kizuki memt CLI & doctor integration", () => {
  test("recall without a daemon serves ledger evidence before a MemT registry exists", () => {
    const setup = tempVault();
    expect(runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
    const result = runCli(setup.env, "memt", "recall", "acme", "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    const { data } = JSON.parse(result.stdout);
    expect(data.degraded).not.toContain("system2-search-unavailable");
    expect(data.items).toContainEqual(expect.objectContaining({
      source: "system2", kind: "event", text: expect.stringContaining("acme library"),
    }));
    expect(existsSync(join(setup.vault, ".kizuki", "memt", "registry.sqlite"))).toBe(false);
  });

  test("memt structured help matches its parser and doctor stays read-only on a clean vault", () => {
    const env = isolatedEnv();
    const help = runCli(env, "help", "memt", "--json");
    expect(help.exitCode).toBe(0);
    const helpBody = JSON.parse(help.stdout) as { data: { name: string; options: string[]; flags: string[] } };
    expect(helpBody.data.name).toBe("memt");
    expect(helpBody.data.flags).toContain("--json");
    expect(helpBody.data.flags).toContain("--dry-run");

    const setup = tempVault();
    const doc = runCli(setup.env, "doctor");
    expect(doc.exitCode).toBe(0);
    expect(doc.stdout).toContain("memt native layer: mode=local-hybrid gpu=offline experiences=0 uninternalized=0 snapshots=0");
    // Doctor and status must NOT create .kizuki/memt/registry.sqlite on a clean vault!
    expect(existsSync(join(setup.vault, ".kizuki", "memt", "registry.sqlite"))).toBe(false);

    const st = runCli(setup.env, "memt", "status", "--json");
    expect(st.exitCode).toBe(0);
    expect(JSON.parse(st.stdout).data).toMatchObject({
      mode: "local-hybrid",
      gpu_backend: "offline",
      experiences: { total: 0, uninternalized: 0 },
    });
    expect(existsSync(join(setup.vault, ".kizuki", "memt", "registry.sqlite"))).toBe(false);
  });

  test("experience add/list/search/verify, recall, sync (--dry-run + live GPU), snapshot list/verify/export, and deploy-check", async () => {
    const setup = tempVault();
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode,
    ).toBe(0);

    // 1. Add procedural experience
    const added = runCli(
      setup.env,
      "memt",
      "experience",
      "add",
      "--domain",
      "ops",
      "--scope-key",
      "recovery",
      "--sensitivity",
      "work",
      "--condition",
      "canon recovery held on authority_changed when live file equals before_hash",
      "--recommendation",
      "run kizuki recover --resolve-stale-hold --apply",
      "--verification",
      "kizuki doctor exits 0",
      "--json",
    );
    expect(added.exitCode, added.stderr).toBe(0);
    const expId = JSON.parse(added.stdout).data.experience.id as string;
    expect(expId).toMatch(/^exp_/);

    // 2. Verify experience outcome
    const verified = runCli(setup.env, "memt", "experience", "verify", expId, "--confidence", "0.95", "--json");
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).data.experience).toMatchObject({
      id: expId,
      outcome: "verified",
      confidence: 0.95,
    });

    // 3. List & search experiences (sensitivity ceiling enforced!)
    expect(
      JSON.parse(runCli(setup.env, "memt", "experience", "list", "--ceiling", "public", "--json").stdout).data.total,
    ).toBe(0);
    expect(
      JSON.parse(runCli(setup.env, "memt", "experience", "list", "--ceiling", "work", "--json").stdout).data.total,
    ).toBe(1);
    const searched = JSON.parse(
      runCli(setup.env, "memt", "experience", "search", "authority_changed", "--domain", "ops", "--json").stdout,
    );
    expect(searched.data.hits).toHaveLength(1);
    expect(searched.data.hits[0].experience.id).toBe(expId);

    // 4. Offline sync reports local-hybrid cleanly without error
    const offlineSync = runCli(setup.env, "memt", "sync", "--json");
    expect(offlineSync.exitCode).toBe(0);
    expect(JSON.parse(offlineSync.stdout).data).toMatchObject({
      mode: "local-hybrid",
      gpu_backend: "offline",
      internalized: false,
      pending_experiences: 1,
    });

    // 5. Connect to live mock MemT-1.0 SGLang server: status, deploy-check, sync --dry-run, sync, recall, snapshot
    const gpuEnv = { ...setup.env, KIZUKI_MEMT_URL: mockUrl };

    const check = await runCliAsync(gpuEnv, "memt", "deploy-check", "--require-online", "--json");
    expect(check.exitCode, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout).data).toMatchObject({
      ready: true,
      endpoint_online: true,
      protocol_compatible: true,
    });

    const drySync = await runCliAsync(gpuEnv, "memt", "sync", "--dry-run", "--json");
    expect(drySync.exitCode).toBe(0);
    expect(JSON.parse(drySync.stdout).data).toMatchObject({
      dry_run: true,
      mode: "native-gpu",
      pending_experiences: 1,
    });

    const liveSync = await runCliAsync(gpuEnv, "memt", "sync", "--json");
    expect(liveSync.exitCode, liveSync.stderr).toBe(0);
    expect(JSON.parse(liveSync.stdout).data).toMatchObject({
      mode: "native-gpu",
      internalized: true,
      experiences_internalized: 1,
    });

    // 6. Snapshot list, verify, and export
    const snapList = JSON.parse((await runCliAsync(gpuEnv, "memt", "snapshot", "list", "--json")).stdout);
    expect(snapList.data.counts.clean).toBe(1);

    const snapVerify = await runCliAsync(gpuEnv, "memt", "snapshot", "verify", "ops", "--json");
    expect(snapVerify.exitCode, snapVerify.stderr).toBe(0);
    expect(JSON.parse(snapVerify.stdout).data.ok).toBe(true);

    const exportedFile = join(setup.root, "ops-export.safetensors");
    const snapExport = await runCliAsync(
      gpuEnv,
      "memt",
      "snapshot",
      "export",
      "--partition",
      "ops",
      "--out",
      exportedFile,
      "--json",
    );
    expect(snapExport.exitCode, snapExport.stderr).toBe(0);
    expect(existsSync(exportedFile)).toBe(true);
    expect((await runCliAsync(gpuEnv, "memt", "snapshot", "verify", exportedFile)).exitCode).toBe(0);

    // 7. Hybrid recall & doctor reporting with native-gpu online
    const recalled = await runCliAsync(gpuEnv, "memt", "recall", "authority_changed", "--domain", "ops", "--json");
    expect(recalled.exitCode, recalled.stderr).toBe(0);
    const recallData = JSON.parse(recalled.stdout).data;
    expect(recallData.mode).toBe("native-gpu");
    expect(recallData.synthesis.source).toBe("memt-native-gpu");
    expect(recallData.experienceCount).toBe(1);

    const docGpu = await runCliAsync(gpuEnv, "doctor");
    expect(docGpu.exitCode).toBe(0);
    expect(docGpu.stdout).toContain("memt native layer: mode=native-gpu gpu=online model=memt-nano");
    expect(docGpu.stdout).toContain("experiences=1 uninternalized=0 snapshots=1");
  });
});
