import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PortContext, PortDescriptor } from "../../src/contracts/ports";
import {
  createRemoteRetrievalPort,
} from "../../src/contracts/remote";
import type {
  RemotePortOptions,
} from "../../src/contracts/remote";
import type { RetrievalPort } from "../../src/contracts/retrieval";
import { RETRIEVAL_CONTRACT } from "../../src/contracts/retrieval";
import { FIXED_NOW } from "./fixtures";

export interface RemoteRetrievalFixture {
  descriptor: PortDescriptor;
  options: RemotePortOptions;
  create(ctx: PortContext): Promise<RetrievalPort>;
  stop(): Promise<void>;
}

async function waitUntilReady(
  process: Bun.Subprocess,
  readyPath: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(readyPath)) {
    if (process.exitCode !== null) {
      throw new Error(
        `remote fixture exited before ready with code ${process.exitCode}`,
      );
    }
    if (Date.now() >= deadline) {
      process.kill();
      throw new Error("remote fixture did not become ready");
    }
    await Bun.sleep(10);
  }
}

export async function startRemoteRetrievalFixture(): Promise<RemoteRetrievalFixture> {
  const root = mkdtempSync(join(tmpdir(), "kz-remote-"));
  const socketPath = join(root, "port.sock");
  const readyPath = join(root, "ready");
  const stateDir = join(root, "state");
  const adapterDir = join(root, "adapter");
  const token = "synthetic-contract-token";
  const secretRef = "env:KIZUKI_CONFORMANCE_REMOTE_TOKEN";
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(adapterDir, { recursive: true });

  const childPath = fileURLToPath(
    new URL("./remote-child.ts", import.meta.url),
  );
  const process = Bun.spawn({
    cmd: [
      processExecPath(),
      childPath,
      socketPath,
      readyPath,
      stateDir,
      token,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitUntilReady(process, readyPath);

  const options: RemotePortOptions = {
    endpoint: { transport: "unix", socket_path: socketPath },
    kind: "retrieval",
    contract: RETRIEVAL_CONTRACT,
    adapter_id: "kizuki.retrieval.remote",
    secret_ref: secretRef,
    handshake_timeout_ms: 1_000,
    response_max_bytes: 1_000_000,
  };
  const baseContext: PortContext = {
    vault_path: root,
    data_dir: adapterDir,
    config: {},
    secrets: async (requested) => {
      if (requested !== secretRef) throw new Error("unexpected secret ref");
      return token;
    },
    clock: () => FIXED_NOW,
    logger: () => {},
  };

  const probe = await createRemoteRetrievalPort(baseContext, options);
  const descriptor = probe.descriptor;
  await probe.close();

  return {
    descriptor,
    options,
    create: async (ctx) =>
      createRemoteRetrievalPort(
        {
          ...ctx,
          secrets: baseContext.secrets,
        },
        options,
      ),
    stop: async () => {
      process.kill("SIGTERM");
      await process.exited;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function processExecPath(): string {
  return process.execPath;
}
