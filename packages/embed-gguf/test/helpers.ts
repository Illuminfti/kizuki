import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk, PortContext, PortDescriptor } from "@kizuki/core";
import { GGUF_EMBEDDING_DESCRIPTOR } from "../src/port";
import { writeFixtureGguf } from "../src/fixture";

export const FIXED_NOW = "2026-09-02T12:00:00.000Z";

export interface TemporaryEmbed {
  root: string;
  vault: string;
  modelPath: string;
  ctx: PortContext;
  cleanup(): void;
}

export function writeTempGguf(
  directory: string,
  overrides: { name?: string; dims?: number } = {},
  filename = "model.gguf",
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename);
  writeFileSync(path, writeFixtureGguf(overrides));
  return path;
}

export function temporaryEmbed(
  config: Record<string, unknown> = {},
  descriptor: PortDescriptor = GGUF_EMBEDDING_DESCRIPTOR,
  modelOverrides: { name?: string; dims?: number } = {},
): TemporaryEmbed {
  const root = mkdtempSync(join(tmpdir(), "kizuki-embed-gguf-"));
  const vault = join(root, "vault");
  const dataDir = join(vault, ".kizuki", descriptor.kind, descriptor.id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const modelPath = writeTempGguf(join(root, "models"), modelOverrides);
  return {
    root,
    vault,
    modelPath,
    ctx: {
      vault_path: vault,
      data_dir: dataDir,
      config: Object.freeze({
        model_path: modelPath,
        context_size: 32,
        batch_size: 4,
        ...config,
      }),
      secrets: async () => {
        throw new Error("embed-gguf tests do not resolve secrets");
      },
      clock: () => FIXED_NOW,
      logger: () => {},
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function fixtureChunks(): Chunk[] {
  return [
    {
      chunk_id: "chunk:grace-0",
      doc_id: "page:grace",
      text: "Grace runs partnerships at Acme.",
      index: 0,
    },
    {
      chunk_id: "chunk:grace-1",
      doc_id: "page:grace",
      text: "Grace can be reached at grace@acme.test.",
      index: 1,
    },
  ];
}
