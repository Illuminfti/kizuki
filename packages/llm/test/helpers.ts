import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRequest, PortContext, PortDescriptor } from "@kizuki/core";
import { PortError } from "@kizuki/core";

export const FIXED_NOW = "2026-09-02T12:00:00.000Z";
export const CANARY_KEY = "canary-key-ada-not-secret";
export const SYNTHETIC_TEXT = "Grace runs partnerships at Acme.";

export const SAMPLE_REQUEST: LlmRequest = {
  messages: [
    {
      role: "system",
      content: "Extract claims from the quoted records below.",
    },
    {
      role: "user",
      content: "Grace runs partnerships at Acme.",
    },
  ],
  max_output_tokens: 64,
  deadline_ms: 5_000,
};

export interface TemporaryLlmContext {
  readonly root: string;
  readonly ctx: PortContext;
  cleanup(): void;
}

export function temporaryLlmContext(
  descriptor: PortDescriptor,
  config: Readonly<Record<string, unknown>> = {},
  secrets: PortContext["secrets"] = async () => CANARY_KEY,
): TemporaryLlmContext {
  const root = mkdtempSync(join(tmpdir(), "kizuki-llm-"));
  const vaultPath = join(root, "vault");
  const dataDir = join(vaultPath, ".kizuki", descriptor.kind, descriptor.id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ctx: {
      vault_path: vaultPath,
      data_dir: dataDir,
      config,
      secrets,
      clock: () => FIXED_NOW,
      logger: () => {
        throw new PortError(
          "config_invalid",
          "llm tests must not log",
          false,
        );
      },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function completionBody(
  content: unknown,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const message = extras["message"];
  const choiceExtras = { ...extras };
  delete choiceExtras["message"];
  delete choiceExtras["usage"];
  delete choiceExtras["model"];
  return {
    id: "cmpl-synthetic",
    object: "chat.completion",
    created: 1,
    model:
      typeof extras["model"] === "string" ? extras["model"] : "synthetic",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message:
          message === undefined
            ? { role: "assistant", content }
            : message,
        ...choiceExtras,
      },
    ],
    usage:
      extras["usage"] === undefined
        ? { prompt_tokens: 8, completion_tokens: 4 }
        : extras["usage"],
  };
}
