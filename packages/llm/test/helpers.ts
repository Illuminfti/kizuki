import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "@kizuki/core";
import { LLM_CONFIG_DEFAULTS } from "../src/config";
import type { LlmConfig } from "../src/config";
import type { Clock } from "../src/client";

export function tempVault(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), "kizuki-llm-"));
  initVault(path);
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ...LLM_CONFIG_DEFAULTS,
    base_url: "http://127.0.0.1:11434/v1",
    model: "fixture-model",
    api_key_ref: null,
    ...overrides,
  };
}

export interface FakeClock extends Clock {
  slept: number[];
  advance: (ms: number) => void;
}

/** Deterministic time: sleeping moves the clock instead of the wall. */
export function fakeClock(start = 1_000_000): FakeClock {
  let at = start;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
  };
}
