#!/usr/bin/env bun
import { UsageError, extractVault } from "./args";
import { COMMANDS } from "./commands/index";
import type { CliIo } from "./commands/index";
import { printCommandHelp, printRootHelp, usageLines } from "./help";
import { errorText } from "./output";
import { createInterface } from "node:readline/promises";
import {
  isRetiredOwnerGateVerb,
  retiredOwnerGateMessage,
} from "./retired";

function processEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    env[key] = value;
  }
  return env;
}

export interface SecretPromptInput {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
  resume(): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown;
}

export interface SecretPromptOutput {
  write(text: string): unknown;
}

/**
 * Read a secret without asking the terminal to conceal already-echoed input.
 * Raw mode means the process receives bytes before the terminal echoes them;
 * this function emits a mask only and restores the terminal on every exit.
 */
export function readSecretPrompt(
  input: SecretPromptInput,
  output: SecretPromptOutput,
  question: string,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    throw new UsageError("interactive sign-in requires a terminal");
  }
  output.write(question);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const characters: string[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let escape: "none" | "introducer" | "csi" | "ss3" = "none";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode!(false);
      output.write("\n");
      if (error !== undefined) reject(error);
      else resolve(characters.join(""));
    };
    const onData = (chunk: Uint8Array): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish(new UsageError("interactive sign-in cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (escape === "introducer") {
          escape = byte === 91 ? "csi" : byte === 79 ? "ss3" : "none";
          continue;
        }
        if (escape === "csi") {
          if (byte >= 64 && byte <= 126) escape = "none";
          continue;
        }
        if (escape === "ss3") {
          escape = "none";
          continue;
        }
        if (byte === 27) {
          escape = "introducer";
          continue;
        }
        if (byte === 8 || byte === 127) {
          if (characters.pop() !== undefined) output.write("\b \b");
          continue;
        }
        if (byte >= 32) {
          let text = "";
          try {
            text = decoder.decode(Uint8Array.of(byte), { stream: true });
          } catch {
            finish(new UsageError("interactive sign-in received invalid terminal input"));
            return;
          }
          for (const character of text) {
            if (character >= " ") {
              characters.push(character);
              output.write("*");
            }
          }
        }
      }
    };
    input.on("data", onData);
  });
}

export async function readVisiblePrompt(question: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    throw new UsageError("interactive sign-in requires a terminal");
  }
  const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  reader.once("SIGINT", onSigint);
  try {
    return await reader.question(question, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new UsageError("interactive sign-in cancelled");
    }
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    reader.off("SIGINT", onSigint);
    reader.close();
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const io: CliIo = {
    env: processEnv(),
    vaultOverride: null,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    out(line) {
      process.stdout.write(`${line}\n`);
    },
    err(line) {
      process.stderr.write(`${line}\n`);
    },
    async prompt(question, opts) {
      if (opts?.secret) {
        return readSecretPrompt(process.stdin, process.stderr, question);
      }
      return readVisiblePrompt(question);
    },
  };

  const extracted = extractVault(argv);
  io.vaultOverride = extracted.vault;
  const verb = extracted.rest[0];
  const args = extracted.rest.slice(1);

  if (verb === undefined) {
    printRootHelp(io.err, COMMANDS);
    return 2;
  }
  if (verb === "help" || verb === "--help") {
    const name = args[0];
    if (name === undefined) {
      printRootHelp(io.out, COMMANDS);
      return 0;
    }
    if (isRetiredOwnerGateVerb(name)) {
      io.err(retiredOwnerGateMessage(name));
      return 2;
    }
    const command = COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
      io.err(`unknown verb: ${name}`);
      printRootHelp(io.err, COMMANDS);
      return 2;
    }
    printCommandHelp(io.out, command);
    return 0;
  }

  if (isRetiredOwnerGateVerb(verb)) {
    io.err(retiredOwnerGateMessage(verb));
    return 2;
  }

  const command = COMMANDS.find((entry) => entry.name === verb);
  if (command === undefined) {
    io.err(`unknown verb: ${verb}`);
    printRootHelp(io.err, COMMANDS);
    return 2;
  }

  if (args.length === 1 && args[0] === "--help") {
    printCommandHelp(io.out, command);
    return 0;
  }

  try {
    return await command.run(io, args);
  } catch (error) {
    if (error instanceof UsageError) {
      for (const line of usageLines(command, error)) io.err(line);
      return 2;
    }
    io.err(`error: ${errorText(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await dispatch(Bun.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write("usage: kizuki <verb> [options]\n");
      process.exit(2);
    } else {
      process.stderr.write(`error: ${errorText(error)}\n`);
      process.exit(1);
    }
  }
}
