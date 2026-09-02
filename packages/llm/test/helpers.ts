import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortError } from "@kizuki/core";
import type {
  PortContext,
  PortDescriptor,
  PortLogLine,
} from "@kizuki/core";
import { OPENAI_COMPATIBLE_LLM, OpenAiCompatibleLlm } from "../src/llm-port";
import type { LlmPortOverrides } from "../src/llm-port";

export interface TestContext {
  ctx: PortContext;
  logs: PortLogLine[];
  cleanup(): void;
}

export function portContext(
  descriptor: PortDescriptor,
  config: Record<string, unknown> = {},
  secrets: (ref: string) => Promise<string> = async () => {
    throw new PortError("unavailable", "no secret is configured", false);
  },
): TestContext {
  const root = mkdtempSync(join(tmpdir(), "kizuki-llm-"));
  const vaultPath = join(root, "vault");
  const dataDir = join(vaultPath, ".kizuki", descriptor.kind, descriptor.id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logs: PortLogLine[] = [];
  return {
    logs,
    ctx: {
      vault_path: vaultPath,
      data_dir: dataDir,
      config: Object.freeze({ ...config }),
      secrets,
      clock: () => "2026-01-01T00:00:00.000Z",
      logger: (line) => logs.push(line),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function llmPort(
  config: Record<string, unknown>,
  overrides: LlmPortOverrides = {},
  secrets?: (ref: string) => Promise<string>,
): { port: OpenAiCompatibleLlm; cleanup(): void } {
  const built =
    secrets === undefined
      ? portContext(OPENAI_COMPATIBLE_LLM, config)
      : portContext(OPENAI_COMPATIBLE_LLM, config, secrets);
  return {
    port: new OpenAiCompatibleLlm(built.ctx, overrides),
    cleanup: built.cleanup,
  };
}
