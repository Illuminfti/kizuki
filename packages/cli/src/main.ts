#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { UsageError, extractVault } from "./args";
import { COMMANDS } from "./commands/index";
import type { CliIo, Command } from "./commands/index";
import { lookupCommandHelp } from "./option-schema";
import { INVOCATION } from "./runtime";
import {
  isRetiredOwnerGateVerb,
  retiredOwnerGateMessage,
} from "./retired";

/** Keep cold CLI startup free of @kizuki/tui and @kizuki/core until a command needs them. */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPIPE") return;
      if (code !== "EAGAIN") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "app_browser_unavailable") {
    const desktop = process.platform === "linux"
      ? "Use a graphical Linux desktop with a default web browser and /usr/bin/xdg-open (usually supplied by xdg-utils)."
      : process.platform === "darwin"
        ? "Use your macOS desktop with a default web browser and /usr/bin/open available."
        : "The local app requires a supported Linux desktop or macOS with a default web browser.";
    return `${message}: ${desktop} Check the default browser, then retry the app command. --no-open is diagnostic; its printed address does not sign you in.`;
  }
  if (message === "canon_files_unsafe") {
    return `${message}: the workspace or a folder above it is a symlink, is not owned by you, or is writable by another user or group. Make each folder yours and not group- or world-writable (for example chmod go-w FOLDER), then run the same command again.`;
  }
  return message;
}

function usageLines(command: Command, error: UsageError): string[] {
  const message = error.message;
  return [
    `error: ${message.length > 0 && message !== command.usage ? message : "invalid arguments"}`,
    `usage: kizuki ${command.usage}`,
    `Try \`${INVOCATION} help ${command.name}\` for flags and examples.`,
  ];
}

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
    const flushDecoder = (): boolean => {
      try {
        if (decoder.decode().length > 0) throw new Error("unexpected text");
        return true;
      } catch {
        finish(new UsageError("interactive sign-in received invalid terminal input"));
        return false;
      }
    };
    const onData = (chunk: Uint8Array): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          if (!flushDecoder()) return;
          finish(new UsageError("interactive sign-in cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          if (!flushDecoder()) return;
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
          if (!flushDecoder()) return;
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
  const { createInterface } = await import("node:readline/promises");
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
      writeAll(1, `${line}\n`);
    },
    err(line) {
      writeAll(2, `${line}\n`);
    },
    async readStdin(maxBytes) {
      if (process.stdin.isTTY === true) return "";
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of Bun.stdin.stream()) {
        chunks.push(chunk);
        size += chunk.byteLength;
        if (size > maxBytes) break;
      }
      return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
    },
    async prompt(question, opts) {
      if (opts?.secret) {
        return readSecretPrompt(process.stdin, process.stderr, question);
      }
      return readVisiblePrompt(question);
    },
  };

  let extracted: ReturnType<typeof extractVault>;
  try {
    extracted = extractVault(argv);
  } catch (error) {
    // Global vault parsing happens before command dispatch, but hooks promise silence on errors.
    let verbIndex = 0;
    while (argv[verbIndex] === "--vault" || argv[verbIndex]?.startsWith("--vault=")) {
      const hasValue = argv[verbIndex + 1] !== undefined && !argv[verbIndex + 1]!.startsWith("--");
      verbIndex += argv[verbIndex] === "--vault" && hasValue ? 2 : 1;
    }
    if (!(error instanceof UsageError) || argv[verbIndex] !== "hook" || argv[verbIndex + 1] !== "session-start") throw error;
    if (argv.includes("--verbose")) io.err("hook: nothing injected (usage)");
    return 0;
  }
  io.vaultOverride = extracted.vault;
  const verb = extracted.rest[0];
  const args = extracted.rest.slice(1);

  if (verb === undefined) {
    const { printRootHelp } = await import("./help");
    printRootHelp(io.err, COMMANDS);
    return 2;
  }
  if (verb === "help" || verb === "--help") {
    const { printCommandHelp, printRootHelp } = await import("./help");
    const json = args.includes("--json");
    const names = args.filter((token) => token !== "--json");
    if (names.length === 0) {
      printRootHelp(io.out, COMMANDS);
      return 0;
    }
    const name = names[0];
    if (name === undefined) {
      printRootHelp(io.out, COMMANDS);
      return 0;
    }
    if (names.length === 1 && isRetiredOwnerGateVerb(name)) {
      io.err(retiredOwnerGateMessage(name));
      return 2;
    }
    const command = COMMANDS.find((entry) => entry.name === name);
    if (names.length === 1) {
      if (command === undefined) {
        io.err(`unknown verb: ${name}`);
        printRootHelp(io.err, COMMANDS);
        return 2;
      }
      printCommandHelp(io.out, command, { json });
      return 0;
    }
    const nested = command === undefined ? undefined : lookupCommandHelp(command.name, names.slice(1));
    if (nested !== undefined) {
      printCommandHelp(io.out, nested, { json });
      return 0;
    }
    io.err("error: invalid arguments");
    io.err("usage: kizuki help [verb] [--json]");
    return 2;
  }

  if (isRetiredOwnerGateVerb(verb)) {
    io.err(retiredOwnerGateMessage(verb));
    return 2;
  }

  const command = COMMANDS.find((entry) => entry.name === verb);
  if (command === undefined) {
    const { printRootHelp } = await import("./help");
    io.err(`unknown verb: ${verb}`);
    printRootHelp(io.err, COMMANDS);
    return 2;
  }

  if (args.includes("--help") && !(verb === "hook" && args[0] === "session-start")) {
    const { printCommandHelp } = await import("./help");
    const json = args.includes("--json");
    const rest = args.filter((token) => token !== "--help" && token !== "--json");
    const topic = rest.length === 0 ? command : lookupCommandHelp(command.name, rest);
    if (topic !== undefined) {
      printCommandHelp(io.out, topic, { json });
      return 0;
    }
    for (const line of usageLines(command, new UsageError("invalid arguments"))) io.err(line);
    return 2;
  }

  try {
    return await command.run(io, args);
  } catch (error) {
    return reportCommandFailure(io, command, error);
  }
}

const SIGN_IN_CANCELLED = "interactive sign-in cancelled";

/** A deliberate Ctrl-C is not a malformed command, so it gets no usage block. */
export function reportCommandFailure(io: Pick<CliIo, "err">, command: Command, error: unknown): number {
  if (error instanceof UsageError && error.message === SIGN_IN_CANCELLED) {
    io.err(`error: ${SIGN_IN_CANCELLED}`);
    return 2;
  }
  if (error instanceof UsageError) {
    for (const line of usageLines(command, error)) io.err(line);
    return 2;
  }
  io.err(`error: ${errorText(error)}`);
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(await dispatch(Bun.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      writeAll(2, `error: ${error.message}\nusage: kizuki <verb> [options]\n`);
      process.exit(2);
    } else {
      writeAll(2, `error: ${errorText(error)}\n`);
      process.exit(1);
    }
  }
}
